// 記帳語意解析的總入口
// 第 5 階段：只用規則解析；第 6 階段會在這裡先試 Gemini，失敗再改用規則解析。

import { parseByRules } from './rules.js';
import { todayIn, isValidYmd } from './dates.js';

export const FIELDS = ['amount', 'direction', 'item', 'date'];

/** 依照缺少的第一個欄位，產生小青蛙的追問 */
export function questionFor(missing, partnerName) {
  switch (missing[0]) {
    case 'amount': return '金額是多少呢？🐸';
    case 'direction': return `這筆是「你借給${partnerName}」，還是「${partnerName}借給你」呢？`;
    case 'item': return '這筆錢是用在什麼項目呢？（例如：晚餐、車票）';
    case 'date': return '是哪一天的事呢？可以說「今天」「昨天」或日期。';
    default: return null;
  }
}

/** 檢查草稿每個欄位是否合法，回傳缺少（或不合法）的欄位清單 */
export function missingFields(fields) {
  const missing = [];
  if (!(Number.isInteger(fields.amount) && fields.amount > 0 && fields.amount <= 100000000)) missing.push('amount');
  if (!['me_lent', 'partner_lent'].includes(fields.direction)) missing.push('direction');
  if (!(typeof fields.item === 'string' && fields.item.trim())) missing.push('item');
  if (!isValidYmd(fields.date)) missing.push('date');
  return missing;
}

/** 只保留合法欄位，避免前端送來奇怪的資料 */
export function sanitizeDraft(input) {
  const draft = input && typeof input === 'object' ? input : {};
  const amount = Number(draft.amount);
  return {
    amount: Number.isInteger(amount) && amount > 0 ? amount : null,
    direction: ['me_lent', 'partner_lent'].includes(draft.direction) ? draft.direction : null,
    item: typeof draft.item === 'string' && draft.item.trim() ? draft.item.trim().slice(0, 30) : null,
    date: isValidYmd(draft.date) ? draft.date : null,
  };
}

/**
 * 解析一句話，並和之前的草稿合併。
 * 追問時只填入「原本缺少」的欄位；如果使用者這句話明確寫了新值，也會覆蓋（例如改口說「不對，是 400」）。
 * ctx = { timeZone, me: { nickname, displayName }, partner: { nickname, displayName } }
 */
export function analyze(text, draft, ctx) {
  const today = todayIn(ctx.timeZone);
  const names = {
    me: unique(['我', ctx.me.nickname, ctx.me.displayName]),
    partner: unique([ctx.partner.nickname, ctx.partner.displayName, '他', '她', '對方', '你', '妳']),
  };
  const before = sanitizeDraft(draft);
  const parsed = parseByRules(text, { today, names });

  const fields = { ...before };
  for (const key of FIELDS) {
    if (parsed[key] === null) continue;
    // 項目比較容易誤判：草稿已有項目時，只有在這句話「只」補項目時才覆蓋
    if (key === 'item' && before.item && (parsed.amount || parsed.direction || parsed.date)) continue;
    fields[key] = parsed[key];
  }
  // 追問項目時，使用者常只回一個詞（例如「晚餐」）
  if (!fields.item && before.amount && !parsed.item && text.trim() && missingFields(before)[0] === 'item') {
    fields.item = text.trim().slice(0, 30);
  }

  const missing = missingFields(fields);
  return {
    fields,
    missing,
    question: questionFor(missing, ctx.partner.nickname),
    source: 'rules',
    today,
  };
}

function unique(list) {
  return [...new Set(list.map((s) => String(s ?? '').trim()).filter((s) => s.length > 0))]
    // 長的名字先比對，避免「咩咩寶」被「咩咩」搶先
    .sort((a, b) => b.length - a.length);
}
