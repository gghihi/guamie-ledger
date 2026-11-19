// 統整：只計算「已同意且未還」的借款，算出雙方各欠多少與差額
// 「已同意且未還」包含：未還（unpaid）、已還待確認（repay_pending，對方還沒確認前仍算未還）
// 可選「全部」或指定月份（依借款日期）。

import { requireUser } from './auth.js';
import { loadLedgerContext } from './loans.js';
import { HttpError, json } from './util.js';

const OPEN_STATUSES = "('unpaid', 'repay_pending')";

/** GET /api/summary?month=YYYY-MM（不帶 month 代表全部） */
export async function getSummary(request, env) {
  const user = await requireUser(request, env);
  const lc = await loadLedgerContext(env, user);
  const month = new URL(request.url).searchParams.get('month') || '';
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, '月份格式不正確', 'bad_month');

  const binds = month ? [user.id, lc.partner.id, lc.ledgerId, month] : [user.id, lc.partner.id, lc.ledgerId];

  const totals = await env.DB.prepare(
    `SELECT
        COALESCE(SUM(CASE WHEN borrower_id = ?1 THEN amount END), 0) AS i_owe,
        COALESCE(SUM(CASE WHEN borrower_id = ?2 THEN amount END), 0) AS partner_owes,
        COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN status = 'repay_pending' THEN 1 END), 0) AS repay_pending
       FROM loans
      WHERE ledger_id = ?3 AND status IN ${OPEN_STATUSES} ${month ? 'AND substr(loan_date, 1, 7) = ?4' : ''}`,
  ).bind(...binds).first();

  // 可以選的月份：所有已同意（未還、已還待確認、已還）紀錄出現過的月份，新的在前
  const { results: monthRows } = await env.DB.prepare(
    `SELECT DISTINCT substr(loan_date, 1, 7) AS m FROM loans
      WHERE ledger_id = ? AND status IN ('unpaid', 'repay_pending', 'paid') ORDER BY m DESC`,
  ).bind(lc.ledgerId).all();

  const iOwe = totals.i_owe;
  const partnerOwes = totals.partner_owes;
  const diff = partnerOwes - iOwe;
  return json(request, env, {
    ok: true,
    month: month || null,
    months: monthRows.map((r) => r.m),
    me: { name: lc.me.nickname, owes: iOwe },
    partner: { name: lc.partner.nickname, owes: partnerOwes },
    // 差額：正數代表對方要給我，負數代表我要給對方
    net: diff === 0
      ? null
      : diff > 0
        ? { from: lc.partner.nickname, to: lc.me.nickname, amount: diff, toMe: true }
        : { from: lc.me.nickname, to: lc.partner.nickname, amount: -diff, toMe: false },
    count: totals.count,
    repayPendingCount: totals.repay_pending,
  });
}
