// 帳本（小窩）、成員、邀請碼
// 第一版規則：每個人只能屬於一本帳；每本帳最多 2 人。

import { requireUser } from './auth.js';
import { HttpError, json, readJson, nowIso, isoAfter, DAY, newId, readableCode, cleanText } from './util.js';

const INVITE_DAYS = 7;

/** 取得使用者所屬的帳本編號（沒有則回傳 null） */
export async function getMyLedgerId(env, userId) {
  const row = await env.DB.prepare('SELECT ledger_id FROM ledger_members WHERE user_id = ?').bind(userId).first();
  return row?.ledger_id ?? null;
}

/**
 * 權限檢查：確認使用者是這本帳的成員，否則一律拒絕。
 * 之後所有讀寫帳目的功能都必須先通過這一關。
 */
export async function requireLedgerMember(env, userId, ledgerId) {
  const row = await env.DB.prepare('SELECT role FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
    .bind(ledgerId, userId)
    .first();
  if (!row) throw new HttpError(403, '你沒有這本帳的權限', 'forbidden');
  return row.role;
}

/** 取得「我的帳本」，沒有加入任何帳本時回 409 */
export async function requireMyLedger(env, userId) {
  const ledgerId = await getMyLedgerId(env, userId);
  if (!ledgerId) throw new HttpError(409, '你還沒有加入任何小窩', 'no_ledger');
  return ledgerId;
}

async function loadLedger(env, ledgerId, meId) {
  const ledger = await env.DB.prepare('SELECT id, name, created_at FROM ledgers WHERE id = ?').bind(ledgerId).first();
  const { results: members } = await env.DB.prepare(
    `SELECT m.user_id, m.role, m.nickname, u.display_name, u.avatar_url
       FROM ledger_members m JOIN users u ON u.id = m.user_id
      WHERE m.ledger_id = ? ORDER BY m.joined_at`,
  ).bind(ledgerId).all();

  let invite = null;
  if (members.length < 2) {
    invite = await env.DB.prepare(
      `SELECT code, expires_at FROM invite_codes
        WHERE ledger_id = ? AND used_by IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(ledgerId, nowIso()).first();
  }
  return {
    id: ledger.id,
    name: ledger.name,
    members: members.map((m) => ({
      userId: m.user_id,
      role: m.role,
      nickname: m.nickname || m.display_name,
      displayName: m.display_name,
      avatarUrl: m.avatar_url,
      isMe: m.user_id === meId,
    })),
    invite: invite ? { code: invite.code, expiresAt: invite.expires_at } : null,
  };
}

async function createInvite(env, ledgerId, userId) {
  // 舊的未使用邀請碼直接作廢，只保留最新一組
  await env.DB.prepare('DELETE FROM invite_codes WHERE ledger_id = ? AND used_by IS NULL').bind(ledgerId).run();
  for (let i = 0; i < 5; i++) {
    const raw = readableCode(8);
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    try {
      await env.DB.prepare('INSERT INTO invite_codes (code, ledger_id, created_by, expires_at) VALUES (?, ?, ?, ?)')
        .bind(code, ledgerId, userId, isoAfter(INVITE_DAYS * DAY))
        .run();
      return code;
    } catch (err) {
      if (!String(err).includes('UNIQUE')) throw err; // 極少數撞號就重抽
    }
  }
  throw new HttpError(500, '邀請碼產生失敗，請再試一次');
}

const normalizeInvite = (value) => {
  const raw = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : '';
};

function cleanNickname(value, fallback) {
  return cleanText(value, 12) || cleanText(fallback, 12) || '我';
}

// ───────────── API ─────────────

/** GET /api/me：我是誰、我在哪本帳 */
export async function getMe(request, env) {
  const user = await requireUser(request, env);
  const ledgerId = await getMyLedgerId(env, user.id);
  return json(request, env, {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      privacyAcknowledged: Boolean(user.privacyAckAt),
    },
    ledger: ledgerId ? await loadLedger(env, ledgerId, user.id) : null,
  });
}

/** POST /api/me/privacy-ack：看過隱私提醒 */
export async function ackPrivacy(request, env) {
  const user = await requireUser(request, env);
  await env.DB.prepare('UPDATE users SET privacy_ack_at = ? WHERE id = ?').bind(nowIso(), user.id).run();
  return json(request, env, { ok: true });
}

/** PATCH /api/me/nickname：修改我在小窩裡的暱稱 */
export async function updateNickname(request, env) {
  const user = await requireUser(request, env);
  const ledgerId = await requireMyLedger(env, user.id);
  const body = await readJson(request);
  const nickname = cleanText(body.nickname, 12);
  if (!nickname) throw new HttpError(400, '暱稱不能空白', 'bad_nickname');
  await env.DB.prepare('UPDATE ledger_members SET nickname = ? WHERE ledger_id = ? AND user_id = ?')
    .bind(nickname, ledgerId, user.id)
    .run();
  return json(request, env, { ok: true, ledger: await loadLedger(env, ledgerId, user.id) });
}

/** POST /api/ledgers：建立小窩，並產生第一組邀請碼 */
export async function createLedger(request, env) {
  const user = await requireUser(request, env);
  if (await getMyLedgerId(env, user.id)) throw new HttpError(409, '你已經在一個小窩裡了', 'already_in_ledger');
  const body = await readJson(request);
  const ledgerId = newId();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO ledgers (id, name, created_by) VALUES (?, ?, ?)')
      .bind(ledgerId, cleanText(body.name, 20) || '呱咩小窩', user.id),
    env.DB.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, nickname) VALUES (?, ?, 'owner', ?)")
      .bind(ledgerId, user.id, cleanNickname(body.nickname, user.displayName)),
  ]);
  await createInvite(env, ledgerId, user.id);
  return json(request, env, { ok: true, ledger: await loadLedger(env, ledgerId, user.id) }, 201);
}

/** POST /api/ledgers/invite：重新產生邀請碼 */
export async function regenerateInvite(request, env) {
  const user = await requireUser(request, env);
  const ledgerId = await requireMyLedger(env, user.id);
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM ledger_members WHERE ledger_id = ?').bind(ledgerId).first();
  if (n >= 2) throw new HttpError(409, '小窩已經有兩個人了，不需要邀請碼', 'ledger_full');
  await createInvite(env, ledgerId, user.id);
  return json(request, env, { ok: true, ledger: await loadLedger(env, ledgerId, user.id) });
}

/** POST /api/ledgers/join：輸入邀請碼加入小窩 */
export async function joinLedger(request, env) {
  const user = await requireUser(request, env);
  if (await getMyLedgerId(env, user.id)) throw new HttpError(409, '你已經在一個小窩裡了', 'already_in_ledger');
  const body = await readJson(request);
  const code = normalizeInvite(body.code);
  if (!code) throw new HttpError(400, '邀請碼是 8 個英文或數字喔', 'bad_invite');

  const invite = await env.DB.prepare('SELECT ledger_id, used_by, expires_at FROM invite_codes WHERE code = ?').bind(code).first();
  if (!invite || invite.used_by || invite.expires_at < nowIso()) {
    throw new HttpError(404, '邀請碼無效或已過期，請對方重新產生', 'bad_invite');
  }

  try {
    // 加入成員與標記邀請碼已使用，兩件事一起成功或一起失敗
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, nickname) VALUES (?, ?, 'member', ?)")
        .bind(invite.ledger_id, user.id, cleanNickname(body.nickname, user.displayName)),
      env.DB.prepare('UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ?').bind(user.id, nowIso(), code),
    ]);
  } catch (err) {
    if (String(err).includes('ledger_full')) throw new HttpError(409, '這個小窩已經滿了', 'ledger_full');
    throw err;
  }
  return json(request, env, { ok: true, ledger: await loadLedger(env, invite.ledger_id, user.id) });
}
