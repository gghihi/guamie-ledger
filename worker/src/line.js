// LINE 機器人（第 12 階段）：綁定、文字記帳、同意／否定、查詢統整、非文字回覆
//
// 流程（白話）：
//  LINE 收到訊息 → 轉給我們的 Webhook（/api/line/webhook）→ 先檢查「簽章」確認真的是 LINE 送來的
//  → 馬上回 LINE「收到了」→ 在背景慢慢處理（例如等 Gemini），再用「回覆」把結果傳回去。
// 回覆訊息不計入 LINE 免費額度；主動推送（通知）才會計入，見 notify.js。

import { requireUser } from './auth.js';
import { loadLedgerContext, createLoanCore, parseCtx } from './loans.js';
import { approveCore, rejectCore } from './loanActions.js';
import { computeSummary } from './summary.js';
import { analyze, missingFields, questionFor, sanitizeDraft } from './parse/index.js';
import { todayIn } from './parse/dates.js';
import { HttpError, json, isoAfter, nowIso } from './util.js';
import { lineFetch, replyLine, text, postback, confirmTemplate, money } from './lineApi.js';

export { notifyLine } from './lineApi.js';

const BIND_CODE_MS = 10 * 60 * 1000;
const enc = new TextEncoder();

// ───────── LINE API 小工具 ─────────

/** 檢查簽章：確認 Webhook 真的是 LINE 送來的（用 Channel secret 計算） */
export async function verifySignature(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

const prettyDate = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${m}/${d}（${'日一二三四五六'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
};
const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const HELP = [
  '🐸 呱咩小窩帳 使用方式',
  '・直接說一句話就能記帳，例如「昨天幫咩咩付晚餐 350」',
  '・傳「統整」查看目前誰欠誰',
  '・傳「取消」放棄正在記的這筆',
  '・語音、圖片請改用網頁版：https://gghihi.github.io/guamie-ledger/',
].join('\n');

// ───────── 網頁版用的 API：綁定 ─────────

/** POST /api/line/bind-code：產生 6 位數綁定碼（10 分鐘內有效） */
export async function createBindCode(request, env) {
  const user = await requireUser(request, env);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM line_bind_codes WHERE user_id = ? OR expires_at < ?').bind(user.id, nowIso()),
    env.DB.prepare('INSERT INTO line_bind_codes (code, user_id, expires_at) VALUES (?, ?, ?)').bind(code, user.id, isoAfter(BIND_CODE_MS)),
  ]);
  return json(request, env, { ok: true, code, expiresAt: isoAfter(BIND_CODE_MS) });
}

/** GET /api/line/status：是否已綁定、機器人加好友連結 */
export async function lineStatus(request, env) {
  const user = await requireUser(request, env);
  const row = await env.DB.prepare('SELECT created_at FROM line_bindings WHERE user_id = ?').bind(user.id).first();
  let addFriendUrl = null;
  if (env.LINE_CHANNEL_ACCESS_TOKEN) {
    try {
      const info = await (await lineFetch(env, '/info')).json();
      if (info.basicId) addFriendUrl = `https://line.me/R/ti/p/${encodeURIComponent(info.basicId)}`;
    } catch { /* 查不到就不顯示 */ }
  }
  return json(request, env, { ok: true, bound: Boolean(row), boundAt: row?.created_at ?? null, addFriendUrl, configured: Boolean(env.LINE_CHANNEL_ACCESS_TOKEN) });
}

/** DELETE /api/line/binding：解除 LINE 綁定 */
export async function unbindLine(request, env) {
  const user = await requireUser(request, env);
  await env.DB.prepare('DELETE FROM line_bindings WHERE user_id = ?').bind(user.id).run();
  return json(request, env, { ok: true });
}

// ───────── Webhook ─────────

/** POST /api/line/webhook：LINE 送來的訊息 */
export async function lineWebhook(request, env) {
  const raw = await request.text();
  const ok = await verifySignature(env.LINE_CHANNEL_SECRET, raw, request.headers.get('x-line-signature'));
  if (!ok) return new Response('bad signature', { status: 401 });

  let events = [];
  try {
    events = JSON.parse(raw).events || [];
  } catch {
    return new Response('bad body', { status: 400 });
  }
  const job = Promise.all(events.map((ev) => handleEvent(env, ev).catch((err) => console.warn('LINE 事件處理失敗', err?.message))));
  if (env.waitUntil) env.waitUntil(job);
  else await job;
  return new Response('ok');
}

/** 處理一則 LINE 事件；回傳要回覆的訊息（也會直接送出） */
export async function handleEvent(env, ev) {
  if (ev.source?.type !== 'user' || !ev.source.userId) return null; // 第一版只處理一對一聊天
  const lineUserId = ev.source.userId;
  const messages = await buildReply(env, ev, lineUserId);
  if (messages && ev.replyToken) await replyLine(env, ev.replyToken, messages);
  return messages;
}

async function buildReply(env, ev, lineUserId) {
  if (ev.type === 'follow') {
    return text('嗨！我是呱咩小窩帳的小青蛙 🐸\n請先到網頁版「LINE 綁定」拿 6 位數綁定碼，再傳「綁定 123456」給我，就可以用 LINE 記帳囉！');
  }

  // 非文字訊息（貼圖、圖片、語音…）
  if (ev.type === 'message' && ev.message?.type !== 'text') {
    if (ev.message?.type === 'audio') return text('小青蛙在 LINE 還聽不懂語音 🙉\n請改打字，或到網頁版用 🎤 語音記帳：https://gghihi.github.io/guamie-ledger/');
    return text('小青蛙目前只看得懂文字喔 🐸\n例如：「昨天幫咩咩付晚餐 350」，或傳「統整」查看欠款。');
  }

  const input = ev.type === 'message' ? String(ev.message.text || '').trim() : '';

  // 綁定（還沒綁定也能用）
  const bindMatch = input.match(/^綁定\s*(\d{6})$/);
  if (bindMatch) return bind(env, lineUserId, bindMatch[1]);

  const binding = await env.DB.prepare(
    'SELECT u.id, u.display_name FROM line_bindings b JOIN users u ON u.id = b.user_id WHERE b.line_user_id = ?',
  ).bind(lineUserId).first();
  if (!binding) {
    return text('這個 LINE 還沒綁定呱咩小窩帳 🐸\n請到網頁版「LINE 綁定」拿 6 位數綁定碼，再傳「綁定 123456」給我。');
  }
  const user = { id: binding.id, displayName: binding.display_name };

  let lc;
  try {
    lc = await loadLedgerContext(env, user);
  } catch (err) {
    if (err instanceof HttpError) return text(`${err.message} 🐸`);
    throw err;
  }

  try {
    if (ev.type === 'postback') return await handlePostback(env, user, lc, lineUserId, new URLSearchParams(ev.postback?.data || ''));
    if (/^(說明|help|使用說明|\?|？)$/i.test(input)) return text(HELP);
    if (/^(統整|統計|查詢|欠款|summary)$/i.test(input)) return summaryMessage(env, user, lc);
    if (/^(取消|算了|不記了)$/.test(input)) {
      await clearDraft(env, lineUserId);
      return text('好的，這筆先不記 🐸');
    }
    return await recordText(env, user, lc, lineUserId, input);
  } catch (err) {
    if (err instanceof HttpError) return text(`😿 ${err.message}`);
    throw err;
  }
}

async function bind(env, lineUserId, code) {
  const row = await env.DB.prepare('DELETE FROM line_bind_codes WHERE code = ? RETURNING user_id, expires_at').bind(code).first();
  if (!row || row.expires_at < nowIso()) return text('綁定碼不正確或已過期，請到網頁版重新產生一組 🐸');
  await env.DB.batch([
    // 一個 LINE 只綁一個帳號、一個帳號只綁一個 LINE：先清掉舊的
    env.DB.prepare('DELETE FROM line_bindings WHERE line_user_id = ? OR user_id = ?').bind(lineUserId, row.user_id),
    env.DB.prepare('INSERT INTO line_bindings (line_user_id, user_id) VALUES (?, ?)').bind(lineUserId, row.user_id),
  ]);
  const user = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind(row.user_id).first();
  return text(`綁定成功！🎉 你好，${user?.display_name || ''}\n\n${HELP}`);
}

// ───────── 記帳草稿 ─────────

async function loadDraft(env, lineUserId, ledgerId) {
  const row = await env.DB.prepare('SELECT draft_json, ledger_id FROM line_drafts WHERE line_user_id = ?').bind(lineUserId).first();
  if (!row || row.ledger_id !== ledgerId) return { fields: null, source: 'rules' };
  try {
    return JSON.parse(row.draft_json);
  } catch {
    return { fields: null, source: 'rules' };
  }
}

const saveDraft = (env, lineUserId, ledgerId, draft) =>
  env.DB.prepare(
    `INSERT INTO line_drafts (line_user_id, ledger_id, draft_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(line_user_id) DO UPDATE SET ledger_id = excluded.ledger_id, draft_json = excluded.draft_json, updated_at = excluded.updated_at`,
  ).bind(lineUserId, ledgerId, JSON.stringify(draft), nowIso()).run();

const clearDraft = (env, lineUserId) => env.DB.prepare('DELETE FROM line_drafts WHERE line_user_id = ?').bind(lineUserId).run();

async function recordText(env, user, lc, lineUserId, input) {
  if (!input) return text(HELP);
  const draft = await loadDraft(env, lineUserId, lc.ledgerId);
  const result = await analyze(input, draft.fields, parseCtx(env, lc), env);
  await saveDraft(env, lineUserId, lc.ledgerId, { fields: result.fields, source: result.source });
  return draftMessage(env, lc, result.fields, { question: result.question, notice: result.notice });
}

/** 把草稿整理成 LINE 訊息：缺欄位就追問（附快速按鈕），齊全就給「確認送出／取消」 */
export function draftMessage(env, lc, fields, { question, notice } = {}) {
  const partner = lc.partner.nickname;
  const missing = missingFields(fields);
  const who = fields.direction === 'me_lent' ? `${partner}欠你` : fields.direction === 'partner_lent' ? `你欠${partner}` : '（還沒填）';
  const lines = [
    '📝 幫你整理好了：',
    `金額：${fields.amount ? money(fields.amount) : '（還沒填）'}`,
    `誰欠誰：${who}`,
    `項目：${fields.item || '（還沒填）'}`,
    `日期：${fields.date ? prettyDate(fields.date) : '（還沒填）'}`,
  ];
  if (notice) lines.push(`🔧 ${notice}`);

  if (missing.length) {
    const items = [];
    if (missing.includes('direction')) {
      items.push(postback(`我借給${partner}`, 'a=dir&v=me_lent'), postback(`${partner}借給我`, 'a=dir&v=partner_lent'));
    }
    if (missing[0] === 'date' || (missing.includes('date') && !missing.includes('direction'))) {
      const today = todayIn(env.APP_TIMEZONE || 'Asia/Taipei');
      items.push(postback('今天', `a=date&v=${today}`), postback('昨天', `a=date&v=${addDays(today, -1)}`), postback('前天', `a=date&v=${addDays(today, -2)}`));
    }
    items.push(postback('取消這筆', 'a=cancel', '取消'));
    return text(`${lines.join('\n')}\n\n${question || questionFor(missing, partner)}`, { items: items.slice(0, 13) });
  }
  return confirmTemplate(
    `確認記帳：${fields.item} ${money(fields.amount)}`,
    `${lines.join('\n')}\n\n確認沒問題就送出，${partner}同意後才會算進統整。`,
    { label: '確認送出', data: 'a=confirm' },
    { label: '取消', data: 'a=cancel' },
  );
}

async function summaryMessage(env, user, lc) {
  const s = await computeSummary(env, user, lc, '');
  const head = s.net ? `👉 ${s.net.from} 要給 ${s.net.to} ${money(s.net.amount)}` : s.count ? '👉 兩不相欠 🎉' : '👉 目前沒有未還的帳 🐸🐑';
  return text([
    '🧮 目前統整（全部）',
    head,
    `・你欠 ${lc.partner.nickname}：${money(s.me.owes)}`,
    `・${lc.partner.nickname} 欠你：${money(s.partner.owes)}`,
    `（只算已同意、還沒還的 ${s.count} 筆${s.repayPendingCount ? `，含 ${s.repayPendingCount} 筆已還待確認` : ''}）`,
  ].join('\n'));
}

// ───────── 按鈕（postback） ─────────

async function handlePostback(env, user, lc, lineUserId, p) {
  const a = p.get('a');

  if (a === 'dir' || a === 'date') {
    const draft = await loadDraft(env, lineUserId, lc.ledgerId);
    if (!draft.fields) return text('這筆已經處理過了，請重新說一次要記的帳 🐸');
    const fields = sanitizeDraft({ ...draft.fields, [a === 'dir' ? 'direction' : 'date']: p.get('v') });
    await saveDraft(env, lineUserId, lc.ledgerId, { ...draft, fields });
    return draftMessage(env, lc, fields);
  }

  if (a === 'cancel') {
    await clearDraft(env, lineUserId);
    return text('好的，這筆先不記 🐸');
  }

  if (a === 'confirm') {
    const draft = await loadDraft(env, lineUserId, lc.ledgerId);
    if (!draft.fields) return text('這筆已經送出或取消了 🐸');
    const loan = await createLoanCore(env, user, lc, draft.fields, ['gemini', 'rules'].includes(draft.source) ? draft.source : 'manual', 'line');
    await clearDraft(env, lineUserId);
    const who = loan.borrower.isMe ? `你欠${lc.partner.nickname}` : `${lc.partner.nickname}欠你`;
    return text(`記好了！${loan.item} ${money(loan.amount)}（${who}）\n等${lc.partner.nickname}確認喔 🐑`);
  }

  // 同意／否定：先問一次「確定嗎？」（確認畫面），再真正執行
  const id = p.get('id');
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return text('這個按鈕已經失效了 🐸');
  const row = await env.DB.prepare('SELECT item, amount, status FROM loans WHERE id = ? AND ledger_id = ?').bind(id, lc.ledgerId).first();
  if (!row) return text('找不到這筆紀錄，可能已被撤回或刪除 🐸');
  const label = `${row.item} ${money(row.amount)}`;

  if (a === 'ask_approve' || a === 'ask_reject') {
    if (row.status !== 'pending') return text(`「${label}」已經處理過了 🐸`);
    const approve = a === 'ask_approve';
    return confirmTemplate(
      `${approve ? '同意' : '否定'}：${label}？`,
      `確定要${approve ? '同意' : '否定'}「${label}」嗎？${approve ? '\n同意後會算進統整。' : '\n（要附原因的話，請到網頁版否定）'}`,
      { label: approve ? '確定同意' : '確定否定', data: `a=${approve ? 'approve' : 'reject'}&id=${id}` },
      { label: '先不要', data: 'a=noop' },
    );
  }
  if (a === 'approve') {
    await approveCore(env, user, lc, id);
    return text(`✅ 已同意「${label}」`);
  }
  if (a === 'reject') {
    await rejectCore(env, user, lc, id, null);
    return text(`❌ 已否定「${label}」，會通知${lc.partner.nickname}`);
  }
  if (a === 'noop') return text('好的，先不處理 🐸');
  return text('這個按鈕已經失效了 🐸');
}
