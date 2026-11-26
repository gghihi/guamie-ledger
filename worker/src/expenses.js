// 直接記帳（花費紀錄）API
//  GET    /api/expenses        列出這本帳的所有花費（新的在前）
//  POST   /api/expenses        新增一筆（不用對方確認，會通知對方）
//  PUT    /api/expenses/:id    修改一筆（兩個人都可以改）
//  DELETE /api/expenses/:id    刪除一筆（兩個人都可以刪）
// 和借款分開：不出現在借還款清單，也不算進統整；歷史紀錄的花費會算給付錢的人。
// 權限：先驗證登入，再限定「我所屬的帳本」，所有 SQL 都帶 ledger_id。

import { requireUser } from './auth.js';
import { requireMyLedger } from './ledgers.js';
import { loadLedgerContext } from './loans.js';
import { sanitizeExpenseDraft, missingExpenseFields } from './parse/expense.js';
import { todayIn } from './parse/dates.js';
import { classifyForLedger } from './categories.js';
import { notify } from './notify.js';
import { HttpError, json, readJson, newId, nowIso } from './util.js';

const FIELD_NAME = { amount: '金額', payer: '誰付的', item: '項目', date: '日期' };

const EXPENSE_SELECT = `
  SELECT e.*,
         COALESCE(mp.nickname, fp.nickname, '已離開的成員') AS payer_name,
         COALESCE(mc.nickname, fc.nickname, '已離開的成員') AS creator_name
    FROM expenses e
    LEFT JOIN ledger_members mp ON mp.ledger_id = e.ledger_id AND mp.user_id = e.payer_id
    LEFT JOIN ledger_members mc ON mc.ledger_id = e.ledger_id AND mc.user_id = e.created_by
    LEFT JOIN ledger_former_members fp ON fp.ledger_id = e.ledger_id AND fp.user_id = e.payer_id
    LEFT JOIN ledger_former_members fc ON fc.ledger_id = e.ledger_id AND fc.user_id = e.created_by`;

function toExpense(r, meId) {
  return {
    id: r.id,
    amount: r.amount,
    item: r.item,
    date: r.expense_date,
    category: r.category || '其他',
    payer: { id: r.payer_id, name: r.payer_name, isMe: r.payer_id === meId },
    createdByMe: r.created_by === meId,
    creatorName: r.creator_name,
    createdAt: r.created_at,
  };
}

async function getExpense(env, ledgerId, id, meId) {
  const row = await env.DB.prepare(`${EXPENSE_SELECT} WHERE e.id = ? AND e.ledger_id = ?`).bind(id, ledgerId).first();
  return row ? toExpense(row, meId) : null;
}

/** 檢查欄位（後端不相信前端），回傳整理好的欄位與付錢的人 id */
function validate(env, body, user, lc) {
  const fields = sanitizeExpenseDraft(body);
  const missing = missingExpenseFields(fields);
  if (missing.length) throw new HttpError(400, `還有欄位沒填好：${missing.map((k) => FIELD_NAME[k]).join('、')}`, 'missing_fields');
  if (fields.date > todayIn(env.APP_TIMEZONE || 'Asia/Taipei')) throw new HttpError(400, '日期不能是未來的日子喔', 'future_date');
  return { fields, payerId: fields.payer === 'me' ? user.id : lc.partner.id };
}

/** GET /api/expenses：只剩一個人的小窩也能看以前的紀錄 */
export async function listExpenses(request, env) {
  const user = await requireUser(request, env);
  const ledgerId = await requireMyLedger(env, user.id);
  const { results } = await env.DB.prepare(
    `${EXPENSE_SELECT} WHERE e.ledger_id = ? ORDER BY e.expense_date DESC, e.created_at DESC`,
  ).bind(ledgerId).all();
  return json(request, env, { ok: true, expenses: results.map((r) => toExpense(r, user.id)) });
}

/** POST /api/expenses：body { amount, payer: 'me'|'partner', item, date, parseSource, inputChannel } */
export async function createExpense(request, env) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const body = await readJson(request);
  const { fields, payerId } = validate(env, body, user, lc);
  const parseSource = ['gemini', 'rules', 'manual'].includes(body.parseSource) ? body.parseSource : 'manual';
  const inputChannel = ['web', 'voice'].includes(body.inputChannel) ? body.inputChannel : 'web';
  const id = newId();
  const category = await classifyForLedger(env, lc.ledgerId, fields.item);
  await env.DB.prepare(
    `INSERT INTO expenses (id, ledger_id, payer_id, amount, item, expense_date, category, created_by, parse_source, input_channel)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, lc.ledgerId, payerId, fields.amount, fields.item, fields.date, category, user.id, parseSource, inputChannel).run();
  notify(env, { type: 'expense_created', toUserId: lc.partner.id, expenseId: id, actorId: user.id });
  return json(request, env, { ok: true, expense: await getExpense(env, lc.ledgerId, id, user.id) }, 201);
}

/** PUT /api/expenses/:id：修改（分類依目前規則重新判斷） */
export async function updateExpense(request, env, { id }) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const body = await readJson(request);
  const { fields, payerId } = validate(env, body, user, lc);
  const category = await classifyForLedger(env, lc.ledgerId, fields.item);
  const res = await env.DB.prepare(
    `UPDATE expenses SET payer_id = ?, amount = ?, item = ?, expense_date = ?, category = ?, updated_at = ?
      WHERE id = ? AND ledger_id = ?`,
  ).bind(payerId, fields.amount, fields.item, fields.date, category, nowIso(), id, lc.ledgerId).run();
  if (!res.meta?.changes) throw new HttpError(404, '找不到這筆紀錄，可能已被刪除', 'not_found');
  return json(request, env, { ok: true, expense: await getExpense(env, lc.ledgerId, id, user.id) });
}

/** DELETE /api/expenses/:id */
export async function deleteExpense(request, env, { id }) {
  const user = await requireUser(request, env);
  const ledgerId = await requireMyLedger(env, user.id);
  const res = await env.DB.prepare('DELETE FROM expenses WHERE id = ? AND ledger_id = ?').bind(id, ledgerId).run();
  if (!res.meta?.changes) throw new HttpError(404, '找不到這筆紀錄，可能已被刪除', 'not_found');
  return json(request, env, { ok: true });
}
