// 歷史紀錄統計（H3）
// 規則（使用者指定）：
//  ・花費只計入「已還」紀錄（待確認、未還、已還待確認都不算），加上「直接記帳」的花費
//  ・直接記帳的花費算給付錢的人（payer_id），月份依記帳日期
//  ・花費歸屬於「實際還款人」（repaid_by）；沒有還款人＝「未指定」，仍計入總花費
//  ・月份依「借款日期」所在月份歸類
//  ・分類用記帳當下存下來的 category（改規則不影響歷史，除非使用者要求重算）
// 權限：先驗證登入，再限定「我所屬的帳本」；只剩一個人的小窩也能查看。

import { requireUser } from './auth.js';
import { requireMyLedger } from './ledgers.js';
import { loadCategories, OTHER } from './categories.js';
import { HttpError, json } from './util.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;

/** 解析期間參數：?month=2026-11 或 ?year=2026（可以都不帶，代表全部） */
function readPeriod(request, { required }) {
  const p = new URL(request.url).searchParams;
  const month = p.get('month') || '';
  const year = p.get('year') || '';
  if (month && year) throw new HttpError(400, '月份和年份只能選一個', 'bad_period');
  if (month && !MONTH_RE.test(month)) throw new HttpError(400, '月份格式不正確（例如 2026-11）', 'bad_period');
  if (year && !YEAR_RE.test(year)) throw new HttpError(400, '年份格式不正確（例如 2026）', 'bad_period');
  if (required && !month && !year) throw new HttpError(400, '請選擇月份或年份', 'bad_period');
  // where：只查借款時用；spendWhere：查「已還借款＋直接記帳」合併的花費時用
  if (month) return { type: 'month', value: month, where: 'substr(l.loan_date, 1, 7) = ?', spendWhere: 'substr(s.d, 1, 7) = ?', bind: month };
  if (year) return { type: 'year', value: year, where: 'substr(l.loan_date, 1, 4) = ?', spendWhere: 'substr(s.d, 1, 4) = ?', bind: year };
  return { type: 'all', value: null, where: '1 = 1', spendWhere: '1 = 1', bind: null };
}

/** 成員與已離開成員的暱稱（顯示還款人名字用） */
async function nameMap(env, ledgerId) {
  const { results } = await env.DB.prepare(
    `SELECT user_id, nickname, 0 AS former FROM ledger_members WHERE ledger_id = ?1
     UNION ALL
     SELECT user_id, nickname, 1 AS former FROM ledger_former_members WHERE ledger_id = ?1`,
  ).bind(ledgerId).all();
  const map = new Map();
  for (const r of results) if (!map.has(r.user_id) || !r.former) map.set(r.user_id, { name: r.nickname || '已離開的成員', former: Boolean(r.former) });
  return map;
}

/** GET /api/history/periods：有紀錄的所有年月與年份（新的在前），附各月已還總額（F1） */
export async function historyPeriods(request, env) {
  const user = await requireUser(request, env);
  const ledgerId = await requireMyLedger(env, user.id);
  // 借款（被否定的不算）與直接記帳都列出月份；總額只算已還借款＋直接記帳
  const { results } = await env.DB.prepare(
    `SELECT month, SUM(paid_total) AS paid_total, SUM(paid_count) AS paid_count FROM (
       SELECT substr(loan_date, 1, 7) AS month,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS paid_total,
              COUNT(CASE WHEN status = 'paid' THEN 1 END) AS paid_count
         FROM loans WHERE ledger_id = ?1 AND status <> 'rejected' GROUP BY month
       UNION ALL
       SELECT substr(expense_date, 1, 7) AS month, SUM(amount), COUNT(*)
         FROM expenses WHERE ledger_id = ?1 GROUP BY month
     ) GROUP BY month ORDER BY month DESC`,
  ).bind(ledgerId).all();
  const months = results.map((r) => ({ month: r.month, paidTotal: r.paid_total, paidCount: r.paid_count }));
  const years = [...new Set(months.map((m) => m.month.slice(0, 4)))];
  return json(request, env, { ok: true, months, years });
}

/**
 * 統計的核心計算（API 與測試共用）。
 * 回傳 { total, count, people: [{ userId, name, amount, count, isMe }], unspecified: { amount, count },
 *        categories: [{ name, amount, count, percent }] }
 */
export async function computeHistory(env, ledgerId, meId, period) {
  // 花費來源：已還的借款（算給還款人）＋直接記帳（算給付錢的人），合併成一張表 s
  const spend = `(
    SELECT amount, repaid_by AS payer, COALESCE(category, '${OTHER}') AS category, loan_date AS d, 'loan' AS kind
      FROM loans WHERE ledger_id = ?1 AND status = 'paid'
    UNION ALL
    SELECT amount, payer_id AS payer, COALESCE(category, '${OTHER}') AS category, expense_date AS d, 'expense' AS kind
      FROM expenses WHERE ledger_id = ?1
  ) s`;
  const binds = period.bind ? [ledgerId, period.bind] : [ledgerId];
  const where = period.bind ? period.spendWhere.replace('?', '?2') : period.spendWhere;
  const base = `FROM ${spend} WHERE ${where}`;

  const totals = await env.DB.prepare(
    `SELECT COALESCE(SUM(s.amount), 0) AS total, COUNT(*) AS count,
            COUNT(CASE WHEN s.kind = 'loan' THEN 1 END) AS loan_count,
            COUNT(CASE WHEN s.kind = 'expense' THEN 1 END) AS expense_count ${base}`,
  ).bind(...binds).first();

  const { results: byPayer } = await env.DB.prepare(
    `SELECT s.payer AS payer, SUM(s.amount) AS amount, COUNT(*) AS count ${base} GROUP BY s.payer`,
  ).bind(...binds).all();

  const { results: byCategory } = await env.DB.prepare(
    `SELECT s.category AS name, SUM(s.amount) AS amount, COUNT(*) AS count ${base} GROUP BY name`,
  ).bind(...binds).all();

  // 每人花費：目前的成員一定列出（沒有花費顯示 0）；已離開的成員有花費才列出
  const names = await nameMap(env, ledgerId);
  const people = [];
  for (const [userId, info] of names) {
    if (info.former) continue;
    const row = byPayer.find((r) => r.payer === userId);
    people.push({ userId, name: info.name, amount: row?.amount ?? 0, count: row?.count ?? 0, isMe: userId === meId });
  }
  for (const r of byPayer) {
    if (!r.payer || people.some((p) => p.userId === r.payer)) continue;
    people.push({ userId: r.payer, name: names.get(r.payer)?.name || '已離開的成員', amount: r.amount, count: r.count, isMe: false, former: true });
  }
  people.sort((a, b) => Number(b.isMe) - Number(a.isMe));
  const unspec = byPayer.find((r) => r.payer === null);

  // 分類：依分類規則的順序排列（「其他」最後）；規則裡已經沒有的舊分類名稱接在後面
  const rules = await loadCategories(env, ledgerId);
  const order = new Map(rules.map((c, i) => [c.name, c.is_other ? 9999 : i]));
  const total = totals.total;
  const categories = byCategory
    .map((r) => ({ name: r.name, amount: r.amount, count: r.count, percent: total ? Math.round((r.amount / total) * 100) : 0 })) // 四捨五入到整數 %
    .sort((a, b) => (order.get(a.name) ?? 5000) - (order.get(b.name) ?? 5000) || b.amount - a.amount);

  return {
    period: { type: period.type, value: period.value },
    total,
    count: totals.count,
    loanCount: totals.loan_count,
    expenseCount: totals.expense_count,
    people,
    unspecified: { amount: unspec?.amount ?? 0, count: unspec?.count ?? 0 },
    categories,
    empty: totals.count === 0,
  };
}

/** GET /api/history?month=2026-11 或 ?year=2026：該期間的花費統計（F2–F5、F7、F8、F13–F15） */
export async function historySummary(request, env) {
  const user = await requireUser(request, env);
  const ledgerId = await requireMyLedger(env, user.id);
  const period = readPeriod(request, { required: true });
  return json(request, env, { ok: true, ...(await computeHistory(env, ledgerId, user.id, period)) });
}

/** GET /api/history/unspecified（可加 ?month= 或 ?year=）：已還但還款人未指定的紀錄（F10） */
export async function historyUnspecified(request, env) {
  const user = await requireUser(request, env);
  const ledgerId = await requireMyLedger(env, user.id);
  const period = readPeriod(request, { required: false });
  const binds = period.bind ? [ledgerId, period.bind] : [ledgerId];
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.item, l.amount, l.loan_date, l.category, l.lender_id, l.borrower_id
       FROM loans l
      WHERE l.ledger_id = ? AND l.status = 'paid' AND l.repaid_by IS NULL AND ${period.where}
      ORDER BY l.loan_date DESC, l.created_at DESC`,
  ).bind(...binds).all();
  const names = await nameMap(env, ledgerId);
  const person = (id) => ({ id, name: names.get(id)?.name || '已離開的成員', isMe: id === user.id });
  return json(request, env, {
    ok: true,
    loans: results.map((r) => ({
      id: r.id,
      item: r.item,
      amount: r.amount,
      date: r.loan_date,
      category: r.category || OTHER,
      // 補填時只能選這兩個人
      lender: person(r.lender_id),
      borrower: person(r.borrower_id),
    })),
  });
}
