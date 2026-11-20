// 借款的狀態操作（第 7 階段）：同意、全部同意、否定、撤回、修改重送、刪除、查看紀錄
//
// 規則（誰能做什麼）：
//   待確認 pending  ：對方（不是記帳的人）可以「同意」或「否定」；記帳的人可以「撤回」
//   被否定 rejected ：記帳的人可以「修改重送」或「刪除」
// 每個操作都用「條件式更新」：只有狀態正確、身分正確時才會成功，避免兩個人同時按造成錯亂。

import { requireUser } from './auth.js';
import { loadLedgerContext, getLoan, fieldName } from './loans.js';
import { missingFields, sanitizeDraft } from './parse/index.js';
import { todayIn } from './parse/dates.js';
import { notify } from './notify.js';
import { HttpError, json, readJson, nowIso, cleanText } from './util.js';

/** 讀取一筆借款（只限自己的帳本），找不到就 404 */
async function loadLoanRow(env, lc, loanId) {
  const row = await env.DB.prepare('SELECT * FROM loans WHERE id = ? AND ledger_id = ?').bind(loanId, lc.ledgerId).first();
  if (!row) throw new HttpError(404, '找不到這筆紀錄，可能已被刪除', 'not_found');
  return row;
}

function snapshot(row) {
  return JSON.stringify({ amount: row.amount, item: row.item, date: row.loan_date, lenderId: row.lender_id, borrowerId: row.borrower_id });
}

function logEvent(env, row, actorId, action, fromStatus, toStatus, note = null, snap = snapshot(row)) {
  return env.DB.prepare(
    `INSERT INTO loan_events (loan_id, ledger_id, actor_id, action, from_status, to_status, note, snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(row.id, row.ledger_id, actorId, action, fromStatus, toStatus, note, snap);
}

/** 狀態不符時的白話錯誤 */
function stateError(row, expected) {
  const names = { pending: '待確認', unpaid: '未還', repay_pending: '已還待確認', paid: '已還', rejected: '被否定' };
  return new HttpError(409, `這筆目前是「${names[row.status] || row.status}」，不能${expected}（可能對方剛剛已處理，請重新整理）`, 'bad_state');
}

// ───────── API ─────────

/** POST /api/loans/:id/approve：同意一筆 */
export async function approveLoan(request, env, { id }) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  return json(request, env, { ok: true, loan: await approveCore(env, user, lc, id) });
}

/** 同意的核心邏輯（網頁和 LINE 共用） */
export async function approveCore(env, user, lc, id) {
  const row = await loadLoanRow(env, lc, id);
  if (row.created_by === user.id) throw new HttpError(403, '自己記的帳要由對方同意喔', 'not_allowed');
  if (row.status !== 'pending') throw stateError(row, '同意');

  const now = nowIso();
  const res = await env.DB.prepare(
    "UPDATE loans SET status = 'unpaid', approved_at = ?, updated_at = ? WHERE id = ? AND ledger_id = ? AND status = 'pending' AND created_by <> ?",
  ).bind(now, now, id, lc.ledgerId, user.id).run();
  if (!res.meta.changes) throw stateError(await loadLoanRow(env, lc, id), '同意');
  await logEvent(env, row, user.id, 'approve', 'pending', 'unpaid').run();
  return getLoan(env, lc, id, user.id);
}

/** POST /api/loans/approve-all：一次同意所有「對方記的、待確認」的帳 */
export async function approveAll(request, env) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const { results: rows } = await env.DB.prepare(
    "SELECT * FROM loans WHERE ledger_id = ? AND status = 'pending' AND created_by <> ?",
  ).bind(lc.ledgerId, user.id).all();
  if (!rows.length) return json(request, env, { ok: true, approved: 0 });

  const now = nowIso();
  const statements = [];
  for (const row of rows) {
    statements.push(
      env.DB.prepare(
        "UPDATE loans SET status = 'unpaid', approved_at = ?, updated_at = ? WHERE id = ? AND ledger_id = ? AND status = 'pending'",
      ).bind(now, now, row.id, lc.ledgerId),
      logEvent(env, row, user.id, 'approve', 'pending', 'unpaid', '全部同意'),
    );
  }
  await env.DB.batch(statements); // 全部一起成功或一起失敗
  return json(request, env, { ok: true, approved: rows.length });
}

/** POST /api/loans/:id/reject：否定一筆（可附原因），並通知記帳的人 */
export async function rejectLoan(request, env, { id }) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const body = await readJson(request).catch(() => ({}));
  const reason = cleanText(body.reason, 100) || null;
  return json(request, env, { ok: true, loan: await rejectCore(env, user, lc, id, reason) });
}

/** 否定的核心邏輯（網頁和 LINE 共用） */
export async function rejectCore(env, user, lc, id, reason = null) {
  const row = await loadLoanRow(env, lc, id);
  if (row.created_by === user.id) throw new HttpError(403, '自己記的帳不能否定，可以用「撤回」', 'not_allowed');
  if (row.status !== 'pending') throw stateError(row, '否定');

  const res = await env.DB.prepare(
    "UPDATE loans SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ? AND ledger_id = ? AND status = 'pending' AND created_by <> ?",
  ).bind(reason, nowIso(), id, lc.ledgerId, user.id).run();
  if (!res.meta.changes) throw stateError(await loadLoanRow(env, lc, id), '否定');
  await logEvent(env, row, user.id, 'reject', 'pending', 'rejected', reason).run();
  notify(env, { type: 'rejected', toUserId: row.created_by, loanId: id, actorId: user.id, note: reason });
  return getLoan(env, lc, id, user.id);
}

/** POST /api/loans/:id/withdraw：對方同意前，記帳的人撤回（直接移除） */
export async function withdrawLoan(request, env, { id }) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const row = await loadLoanRow(env, lc, id);
  if (row.created_by !== user.id) throw new HttpError(403, '只有記帳的人可以撤回', 'not_allowed');
  if (row.status !== 'pending') throw stateError(row, '撤回');

  const res = await env.DB.prepare(
    "DELETE FROM loans WHERE id = ? AND ledger_id = ? AND status = 'pending' AND created_by = ?",
  ).bind(id, lc.ledgerId, user.id).run();
  if (!res.meta.changes) throw stateError(await loadLoanRow(env, lc, id), '撤回');
  await logEvent(env, row, user.id, 'withdraw', 'pending', null).run();
  return json(request, env, { ok: true });
}

/** PUT /api/loans/:id：被否定後，記帳的人修改並重送（回到待確認） */
export async function resubmitLoan(request, env, { id }) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const row = await loadLoanRow(env, lc, id);
  if (row.created_by !== user.id) throw new HttpError(403, '只有記帳的人可以修改', 'not_allowed');
  if (row.status !== 'rejected') throw stateError(row, '修改重送');

  const fields = sanitizeDraft(await readJson(request));
  const missing = missingFields(fields);
  if (missing.length) throw new HttpError(400, `還有欄位沒填好：${missing.map(fieldName).join('、')}`, 'missing_fields');
  if (fields.date > todayIn(env.APP_TIMEZONE || 'Asia/Taipei')) throw new HttpError(400, '日期不能是未來的日子喔', 'future_date');

  const lenderId = fields.direction === 'me_lent' ? user.id : lc.partner.id;
  const borrowerId = fields.direction === 'me_lent' ? lc.partner.id : user.id;
  const res = await env.DB.prepare(
    `UPDATE loans SET amount = ?, item = ?, loan_date = ?, lender_id = ?, borrower_id = ?,
            status = 'pending', reject_reason = NULL, updated_at = ?
      WHERE id = ? AND ledger_id = ? AND status = 'rejected' AND created_by = ?`,
  ).bind(fields.amount, fields.item, fields.date, lenderId, borrowerId, nowIso(), id, lc.ledgerId, user.id).run();
  if (!res.meta.changes) throw stateError(await loadLoanRow(env, lc, id), '修改重送');

  const snap = JSON.stringify({ amount: fields.amount, item: fields.item, date: fields.date, lenderId, borrowerId });
  await logEvent(env, row, user.id, 'resubmit', 'rejected', 'pending', null, snap).run();
  notify(env, { type: 'resubmitted', toUserId: lc.partner.id, loanId: id, actorId: user.id });
  return json(request, env, { ok: true, loan: await getLoan(env, lc, id, user.id) });
}

// ───────── 第 8 階段：還款 ─────────

/** POST /api/loans/:id/repay：任一方標記「已還款」→ 已還待確認，並通知另一方 */
export async function requestRepay(request, env, { id }) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const row = await loadLoanRow(env, lc, id);
  if (row.status !== 'unpaid') throw stateError(row, '標記還款');

  const res = await env.DB.prepare(
    "UPDATE loans SET status = 'repay_pending', repay_requested_by = ?, updated_at = ? WHERE id = ? AND ledger_id = ? AND status = 'unpaid'",
  ).bind(user.id, nowIso(), id, lc.ledgerId).run();
  if (!res.meta.changes) throw stateError(await loadLoanRow(env, lc, id), '標記還款');
  await logEvent(env, row, user.id, 'request_repay', 'unpaid', 'repay_pending').run();
  notify(env, { type: 'repay_pending', toUserId: lc.partner.id, loanId: id, actorId: user.id });
  return json(request, env, { ok: true, loan: await getLoan(env, lc, id, user.id) });
}

/** POST /api/loans/:id/confirm-repay：另一方確認 → 已還，並通知標記的人 */
export async function confirmRepay(request, env, { id }) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const row = await loadLoanRow(env, lc, id);
  if (row.status !== 'repay_pending') throw stateError(row, '確認還款');
  if (row.repay_requested_by === user.id) throw new HttpError(403, '自己標記的還款要由對方確認喔', 'not_allowed');

  const now = nowIso();
  const res = await env.DB.prepare(
    "UPDATE loans SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ? AND ledger_id = ? AND status = 'repay_pending' AND repay_requested_by <> ?",
  ).bind(now, now, id, lc.ledgerId, user.id).run();
  if (!res.meta.changes) throw stateError(await loadLoanRow(env, lc, id), '確認還款');
  await logEvent(env, row, user.id, 'confirm_repay', 'repay_pending', 'paid').run();
  notify(env, { type: 'repay_confirmed', toUserId: row.repay_requested_by, loanId: id, actorId: user.id });
  return json(request, env, { ok: true, loan: await getLoan(env, lc, id, user.id) });
}

/** POST /api/loans/:id/cancel-repay：標記的人按錯了，取消還款標記 → 回到未還 */
export async function cancelRepay(request, env, { id }) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const row = await loadLoanRow(env, lc, id);
  if (row.status !== 'repay_pending') throw stateError(row, '取消還款標記');
  if (row.repay_requested_by !== user.id) throw new HttpError(403, '只有標記還款的人可以取消；你可以按「還沒收到」', 'not_allowed');

  const res = await env.DB.prepare(
    "UPDATE loans SET status = 'unpaid', repay_requested_by = NULL, updated_at = ? WHERE id = ? AND ledger_id = ? AND status = 'repay_pending' AND repay_requested_by = ?",
  ).bind(nowIso(), id, lc.ledgerId, user.id).run();
  if (!res.meta.changes) throw stateError(await loadLoanRow(env, lc, id), '取消還款標記');
  await logEvent(env, row, user.id, 'cancel_repay', 'repay_pending', 'unpaid').run();
  return json(request, env, { ok: true, loan: await getLoan(env, lc, id, user.id) });
}

/** POST /api/loans/:id/decline-repay：對方說「還沒收到」→ 退回未還（可附原因），並通知標記的人 */
export async function declineRepay(request, env, { id }) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const body = await readJson(request).catch(() => ({}));
  const reason = cleanText(body.reason, 100) || null;
  const row = await loadLoanRow(env, lc, id);
  if (row.status !== 'repay_pending') throw stateError(row, '退回還款');
  if (row.repay_requested_by === user.id) throw new HttpError(403, '自己標記的還款請用「取消標記」', 'not_allowed');

  const res = await env.DB.prepare(
    "UPDATE loans SET status = 'unpaid', repay_requested_by = NULL, updated_at = ? WHERE id = ? AND ledger_id = ? AND status = 'repay_pending' AND repay_requested_by <> ?",
  ).bind(nowIso(), id, lc.ledgerId, user.id).run();
  if (!res.meta.changes) throw stateError(await loadLoanRow(env, lc, id), '退回還款');
  await logEvent(env, row, user.id, 'decline_repay', 'repay_pending', 'unpaid', reason).run();
  notify(env, { type: 'repay_declined', toUserId: row.repay_requested_by, loanId: id, actorId: user.id, note: reason });
  return json(request, env, { ok: true, loan: await getLoan(env, lc, id, user.id) });
}

/**
 * DELETE /api/loans/:id：刪除紀錄
 *  被否定 rejected：記帳的人可以刪除
 *  已還 paid：任一方都可以刪除
 */
export async function deleteLoan(request, env, { id }) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const row = await loadLoanRow(env, lc, id);
  const allowed = (row.status === 'rejected' && row.created_by === user.id) || row.status === 'paid';
  if (!allowed) {
    if (row.status === 'rejected') throw new HttpError(403, '被否定的紀錄只有記帳的人可以刪除', 'not_allowed');
    throw stateError(row, '刪除');
  }
  const res = await env.DB.prepare('DELETE FROM loans WHERE id = ? AND ledger_id = ? AND status = ?')
    .bind(id, lc.ledgerId, row.status).run();
  if (!res.meta.changes) throw stateError(await loadLoanRow(env, lc, id), '刪除');
  await logEvent(env, row, user.id, 'delete', row.status, null).run();
  return json(request, env, { ok: true });
}

/** GET /api/loans/:id/events：這筆紀錄的狀態變更歷史 */
export async function loanEvents(request, env, { id }) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const { results } = await env.DB.prepare(
    `SELECT e.action, e.from_status, e.to_status, e.note, e.snapshot, e.created_at, e.actor_id,
            COALESCE(m.nickname, f.nickname, '已離開的成員') AS actor_name
       FROM loan_events e
       LEFT JOIN ledger_members m ON m.ledger_id = e.ledger_id AND m.user_id = e.actor_id
       LEFT JOIN ledger_former_members f ON f.ledger_id = e.ledger_id AND f.user_id = e.actor_id
      WHERE e.loan_id = ? AND e.ledger_id = ? ORDER BY e.id`,
  ).bind(id, lc.ledgerId).all();
  if (!results.length) throw new HttpError(404, '找不到這筆紀錄', 'not_found');
  return json(request, env, {
    ok: true,
    events: results.map((e) => ({
      action: e.action,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      note: e.note,
      snapshot: e.snapshot ? JSON.parse(e.snapshot) : null,
      at: e.created_at,
      actorName: e.actor_name,
      byMe: e.actor_id === user.id,
    })),
  });
}
