// 直接記帳（花費）的語意解析：從一句話抓出「金額、誰付的、項目、日期」
// 例如「咩咩今天買菜 500」→ 金額 500、咩咩付的、買菜、今天。
// 一樣先請 Gemini 理解，失敗才用規則；看不懂的欄位留空交給追問，不亂猜。

import { findDate, todayIn, isValidYmd } from './dates.js';
import { findAmount, cleanItem, escapeRe } from './rules.js';
import { parseWithGemini, GeminiError, todayLine } from './gemini.js';
import { FALLBACK_NOTICE } from './index.js';

export const EXPENSE_FIELDS = ['amount', 'payer', 'item', 'date'];

/** 檢查草稿每個欄位，回傳缺少的欄位清單 */
export function missingExpenseFields(f) {
  const missing = [];
  if (!(Number.isInteger(f.amount) && f.amount > 0 && f.amount <= 100000000)) missing.push('amount');
  if (!['me', 'partner'].includes(f.payer)) missing.push('payer');
  if (!(typeof f.item === 'string' && f.item.trim())) missing.push('item');
  if (!isValidYmd(f.date)) missing.push('date');
  return missing;
}

/** 只保留合法欄位 */
export function sanitizeExpenseDraft(input) {
  const d = input && typeof input === 'object' ? input : {};
  const amount = Number(d.amount);
  return {
    amount: Number.isInteger(amount) && amount > 0 ? amount : null,
    payer: ['me', 'partner'].includes(d.payer) ? d.payer : null,
    item: typeof d.item === 'string' && d.item.trim() ? d.item.trim().slice(0, 30) : null,
    date: isValidYmd(d.date) ? d.date : null,
  };
}

export function expenseQuestion(missing, partnerName) {
  switch (missing[0]) {
    case 'amount': return '花了多少錢呢？🐸';
    case 'payer': return `這筆是誰付的錢？「我」還是「${partnerName}」？`;
    case 'item': return '買了什麼呢？（例如：買菜、電費）';
    case 'date': return '是哪一天的花費呢？可以說「今天」「昨天」或日期。';
    default: return null;
  }
}

// ───────── Gemini 的回答格式 ─────────

const EXPENSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isExpense: { type: 'BOOLEAN', description: '這句話是否在描述一筆花費／消費' },
    amount: { type: 'INTEGER', nullable: true, description: '新台幣金額（整數）；不確定就 null' },
    payer: { type: 'STRING', enum: ['me', 'partner', 'unknown'], description: '誰付的錢：me＝使用者本人；partner＝另一半；不確定就 unknown' },
    item: { type: 'STRING', nullable: true, description: '簡短項目名稱，例如「買菜」「電費」，最多 15 字；不確定就 null' },
    date: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD；句子沒提到日期就 null' },
    transcript: { type: 'STRING', nullable: true, description: '若輸入是語音，填入聽到的文字；文字輸入則 null' },
  },
  required: ['isExpense', 'amount', 'payer', 'item', 'date'],
};

function expensePrompt(ctx) {
  return [
    '你是兩人記帳 APP「呱咩小窩帳」的記帳小幫手，現在是「直接記帳」模式：使用者在記一筆已經付掉的花費（不是借錢）。',
    todayLine(ctx.today),
    `使用者本人的稱呼：${ctx.names.me.join('、')}。另一半的稱呼：${ctx.names.partner.join('、')}。`,
    '規則：',
    '1. 只擷取句子裡明確提到的資訊。不確定的欄位一律填 null 或 unknown，絕對不要猜金額或誰付的。',
    '2. payer：句子的主詞是使用者本人（或用「我」）→ me；主詞是另一半 → partner。沒說是誰付的 → unknown。',
    '3. 與花錢無關的句子 isExpense 才填 false；資訊不完整（例如只有「買菜 500」）仍填 true，缺的欄位填 null。',
    '4. 「今天、昨天、上週五、18號」等相對日期依今天換算成 YYYY-MM-DD；沒提到日期就填 null，不要自動填今天。',
    '5. 金額換成新台幣整數，例如「三百五」→350、「1.5萬」→15000。若有多個數字且無法判斷哪個是金額，填 null。',
    '6. item 只寫簡短名詞，不要包含人名、金額、日期。',
  ].join('\n');
}

export function sanitizeExpenseOutput(out, today) {
  if (!out || typeof out !== 'object') throw new GeminiError('bad_output');
  const amount = Number.isInteger(out.amount) && out.amount > 0 && out.amount <= 100000000 ? out.amount : null;
  const payer = ['me', 'partner'].includes(out.payer) ? out.payer : null;
  const item = typeof out.item === 'string' && out.item.trim() ? out.item.trim().slice(0, 30) : null;
  const date = isValidYmd(out.date) && out.date <= today ? out.date : null;
  const transcript = typeof out.transcript === 'string' ? out.transcript.trim().slice(0, 200) : null;
  return { isExpense: out.isExpense !== false, amount, payer, item, date, transcript };
}

export const EXPENSE_SPEC = {
  schema: EXPENSE_SCHEMA,
  prompt: expensePrompt,
  sanitize: sanitizeExpenseOutput,
  audioHint: '請聽這段錄音並擷取花費資料。',
};

// ───────── 規則解析（備用） ─────────

/**
 * 不靠 AI 的解析：日期 → 金額 → 誰付的（句子裡最先出現的人）→ 剩下的字當項目
 * ctx = { today, names: { me: [...], partner: [...] } }
 */
export function parseExpenseByRules(input, ctx) {
  let text = String(input ?? '').normalize('NFKC').trim();
  const result = { amount: null, payer: null, item: null, date: null };
  if (!text) return result;

  const date = findDate(text, ctx.today);
  if (date) {
    result.date = date.date;
    text = text.replace(date.text, ' ');
  }
  const amount = findAmount(text);
  if (amount) {
    result.amount = amount.amount;
    text = text.replace(amount.text, ' ');
  }
  // 誰付的：找最先出現的名字（主詞通常在最前面）
  const people = [...ctx.names.me.map((n) => ['me', n]), ...ctx.names.partner.map((n) => ['partner', n])];
  let first = null;
  for (const [who, name] of people) {
    const i = text.indexOf(name);
    if (i >= 0 && (!first || i < first.i)) first = { who, i };
  }
  if (first) result.payer = first.who;
  for (const [, name] of people) text = text.split(name).join(' ');
  text = text.replace(new RegExp(`(?:${['付了', '付', '花了', '花', '出了', '出', '幫', '帮'].map(escapeRe).join('|')})(?=\\s|$)`, 'g'), ' ');
  // 開頭的「付、花了、繳了」不算項目（「付電費」→「電費」）；「買菜」的「買」保留
  const item = cleanItem(text);
  result.item = item ? item.replace(/^(?:付了?|花了?|繳了?|缴了?|出了?)s*/, '') || null : null;
  return result;
}

function buildNames(ctx) {
  const uniq = (list) => [...new Set(list.map((s) => String(s ?? '').trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  return {
    me: uniq(['我', ctx.me.nickname, ctx.me.displayName]),
    partner: uniq([ctx.partner.nickname, ctx.partner.displayName, '他', '她', '對方']),
  };
}

/**
 * 解析一句話（或錄音），和之前的草稿合併。
 * 回傳 { fields, missing, question, source, notice, transcript, today }
 */
export async function analyzeExpense(input, draft, ctx, env = {}, fetchImpl) {
  const today = todayIn(ctx.timeZone);
  const names = buildNames(ctx);
  const before = sanitizeExpenseDraft(draft);
  let text = typeof input === 'string' ? input.trim() : (input.text || '').trim();
  const audio = typeof input === 'object' ? input.audio : null;
  const forceRules = /^#備用\s*/.test(text);
  text = text.replace(/^#備用\s*/, '');

  let parsed = null;
  let source = 'gemini';
  let notice = null;
  let transcript = null;

  if (!forceRules) {
    try {
      const ai = await parseWithGemini(audio ? { audio } : { text }, { today, names }, env, fetchImpl, EXPENSE_SPEC);
      transcript = ai.transcript;
      const isFollowUp = EXPENSE_FIELDS.some((k) => before[k] !== null);
      if (!ai.isExpense && !isFollowUp) {
        return { fields: before, missing: missingExpenseFields(before), question: '這句話看起來不像花費。可以說說花了多少、買了什麼嗎？🐸', source, notice, transcript, today };
      }
      parsed = ai;
    } catch (err) {
      if (!(err instanceof GeminiError)) throw err;
      console.warn('Gemini 失敗，改用規則解析：', err.reason, err.detail || '');
    }
  }

  if (!parsed) {
    if (audio && !text) {
      return {
        fields: before,
        missing: missingExpenseFields(before),
        question: '小青蛙現在聽不懂語音 😿 請改用打字，或用鍵盤上的麥克風說話。',
        source: 'rules',
        notice: FALLBACK_NOTICE,
        transcript: null,
        today,
      };
    }
    parsed = parseExpenseByRules(text, { today, names });
    source = 'rules';
    notice = FALLBACK_NOTICE;
  }

  // 合併：這句話有說到的欄位才覆蓋；追問項目時只回一個詞，就當作項目
  const fields = { ...before };
  for (const key of EXPENSE_FIELDS) {
    if (parsed[key] === null || parsed[key] === undefined) continue;
    if (key === 'item' && before.item && (parsed.amount || parsed.payer || parsed.date)) continue;
    fields[key] = parsed[key];
  }
  if (!fields.item && before.amount && !parsed.item && text && missingExpenseFields(before)[0] === 'item') {
    fields.item = text.slice(0, 30);
  }
  const missing = missingExpenseFields(fields);
  return { fields, missing, question: expenseQuestion(missing, ctx.partner.nickname), source, notice, transcript, today };
}
