// 借款紀錄：解析一句話、新增借款、列出借款
// 第 5 階段：新增後一律進入「待確認」。同意／否定等操作在第 7 階段加入。

import { requireUser } from './auth.js';
import { requireMyLedger } from './ledgers.js';
import { analyze, missingFields, sanitizeDraft, FIELDS } from './parse/index.js';
import { todayIn } from './parse/dates.js';
import { HttpError, json, readJson, newId, cleanText } from './util.js';
import { notify } from './notify.js';

/**
 * 取得「我、對方、帳本」的資料。記帳一定要兩個人都在小窩裡。
 * 這裡同時完成權限檢查：只會拿到自己所屬帳本的資料。
 */
export async function loadLedgerContext(env, user) {
  const ledgerId = await requireMyLedger(env, user.id);
  const { results } = await env.DB.prepare(
    `SELECT m.user_id, m.nickname, u.display_name
       FROM ledger_members m JOIN users u ON u.id = m.user_id
      WHERE m.ledger_id = ?`,
  ).bind(ledgerId).all();
  const toPerson = (r) => ({ id: r.user_id, nickname: r.nickname || r.display_name, displayName: r.display_name });
  const me = results.find((r) => r.user_id === user.id);
  const partner = results.find((r) => r.user_id !== user.id);
  if (!partner) throw new HttpError(409, '另一半還沒加入小窩，加入後才能記帳喔', 'no_partner');
  return { ledgerId, me: toPerson(me), partner: toPerson(partner) };
}

const parseCtx = (env, lc) => ({ timeZone: env.APP_TIMEZONE || 'Asia/Taipei', me: lc.me, partner: lc.partner });

/** POST /api/parse：把一句話解析成欄位，並告訴前端還缺什麼 */
export async function parseText(request, env) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const body = await readJson(request);
  const text = cleanText(body.text, 300);
  if (!text) throw new HttpError(400, '請先輸入一句話', 'empty_text');
  const result = await analyze(text, body.draft, parseCtx(env, lc), env);
  return json(request, env, { ok: true, ...result });
}

// 語音限制：16kHz 單聲道 WAV，30 秒約 960KB，轉成文字編碼後約 1.3MB
const MAX_AUDIO_BASE64 = 1_400_000;
const AUDIO_TYPES = ['audio/wav'];

/** POST /api/parse-voice：把一段錄音交給 Gemini 理解（語音一律由 Gemini 處理） */
export async function parseVoice(request, env) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const body = await readJson(request);
  const audio = body.audio || {};
  if (!AUDIO_TYPES.includes(audio.mimeType) || typeof audio.base64 !== 'string' || !audio.base64) {
    throw new HttpError(400, '錄音格式不正確，請再錄一次', 'bad_audio');
  }
  if (audio.base64.length > MAX_AUDIO_BASE64) throw new HttpError(413, '錄音太長了，請在 30 秒內說完', 'audio_too_long');
  if (!/^[A-Za-z0-9+/]+=*$/.test(audio.base64.slice(-100))) throw new HttpError(400, '錄音內容不正確', 'bad_audio');

  const result = await analyze({ audio: { mimeType: audio.mimeType, base64: audio.base64 } }, body.draft, parseCtx(env, lc), env);
  return json(request, env, { ok: true, ...result });
}

/** POST /api/loans：確認後送出一筆借款（進入「待確認」） */
export async function createLoan(request, env) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const body = await readJson(request);

  // 後端再檢查一次，不相信前端送來的資料
  const fields = sanitizeDraft(body);
  const missing = missingFields(fields);
  if (missing.length) {
    throw new HttpError(400, `還有欄位沒填好：${missing.map(fieldName).join('、')}`, 'missing_fields');
  }
  const today = todayIn(env.APP_TIMEZONE || 'Asia/Taipei');
  if (fields.date > today) throw new HttpError(400, '日期不能是未來的日子喔', 'future_date');

  const lenderId = fields.direction === 'me_lent' ? user.id : lc.partner.id;
  const borrowerId = fields.direction === 'me_lent' ? lc.partner.id : user.id;
  const parseSource = ['gemini', 'rules', 'manual'].includes(body.parseSource) ? body.parseSource : 'manual';
  const inputChannel = ['web', 'voice'].includes(body.inputChannel) ? body.inputChannel : 'web';
  const id = newId();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO loans (id, ledger_id, lender_id, borrower_id, amount, item, loan_date, created_by, parse_source, input_channel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, lc.ledgerId, lenderId, borrowerId, fields.amount, fields.item, fields.date, user.id, parseSource, inputChannel),
    env.DB.prepare(
      `INSERT INTO loan_events (loan_id, ledger_id, actor_id, action, from_status, to_status, snapshot)
       VALUES (?, ?, ?, 'create', NULL, 'pending', ?)`,
    ).bind(id, lc.ledgerId, user.id, JSON.stringify({ amount: fields.amount, item: fields.item, date: fields.date, lenderId, borrowerId })),
  ]);

  await notify(env, { type: 'new_pending', toUserId: lc.partner.id, loan: { id } });
  return json(request, env, { ok: true, loan: await getLoan(env, lc, id, user.id) }, 201);
}

/** GET /api/loans：列出我這本帳的所有借款 */
export async function listLoans(request, env) {
  const user = await requireUser(request, env);
  const ledgerId = await requireMyLedger(env, user.id);
  const { results } = await env.DB.prepare(
    `${LOAN_SELECT} WHERE l.ledger_id = ? ORDER BY l.loan_date DESC, l.created_at DESC`,
  ).bind(ledgerId).all();
  return json(request, env, { ok: true, loans: results.map((r) => toLoan(r, user.id)) });
}

const LOAN_SELECT = `
  SELECT l.*, ml.nickname AS lender_name, mb.nickname AS borrower_name, mc.nickname AS creator_name
    FROM loans l
    LEFT JOIN ledger_members ml ON ml.ledger_id = l.ledger_id AND ml.user_id = l.lender_id
    LEFT JOIN ledger_members mb ON mb.ledger_id = l.ledger_id AND mb.user_id = l.borrower_id
    LEFT JOIN ledger_members mc ON mc.ledger_id = l.ledger_id AND mc.user_id = l.created_by`;

export async function getLoan(env, lc, id, meId) {
  const row = await env.DB.prepare(`${LOAN_SELECT} WHERE l.id = ? AND l.ledger_id = ?`).bind(id, lc.ledgerId).first();
  return row ? toLoan(row, meId) : null;
}

function toLoan(r, meId) {
  return {
    id: r.id,
    amount: r.amount,
    item: r.item,
    date: r.loan_date,
    status: r.status,
    lender: { id: r.lender_id, name: r.lender_name, isMe: r.lender_id === meId },
    borrower: { id: r.borrower_id, name: r.borrower_name, isMe: r.borrower_id === meId },
    createdByMe: r.created_by === meId,
    creatorName: r.creator_name,
    rejectReason: r.reject_reason,
    repayRequestedByMe: r.repay_requested_by ? r.repay_requested_by === meId : null,
    paidAt: r.paid_at,
    parseSource: r.parse_source,
    inputChannel: r.input_channel,
    createdAt: r.created_at,
  };
}

export const fieldName = (key) => ({ amount: '金額', direction: '誰欠誰', item: '項目', date: '日期' })[key] || key;
export { FIELDS };
