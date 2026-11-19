// 記帳語意解析的總入口
// 先請 Gemini 理解；Gemini 無法使用（沒金鑰、額度用完、錯誤、逾時）時，自動改用規則解析。

import { parseByRules } from './rules.js';
import { todayIn, isValidYmd } from './dates.js';
import { parseWithGemini, GeminiError } from './gemini.js';

export const FIELDS = ['amount', 'direction', 'item', 'date'];

/** 測試用開關：句子開頭打「#備用」就強制使用規則解析（方便測試備用機制） */
const FORCE_RULES_PREFIX = /^#備用\s*/;

export const FALLBACK_NOTICE = '目前使用備用解析';

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

function buildNames(ctx) {
  return {
    me: unique(['我', ctx.me.nickname, ctx.me.displayName]),
    partner: unique([ctx.partner.nickname, ctx.partner.displayName, '他', '她', '對方', '你', '妳']),
  };
}

/** 把這句話的解析結果合併進草稿 */
function merge(before, parsed, text) {
  const fields = { ...before };
  for (const key of FIELDS) {
    if (parsed[key] === null || parsed[key] === undefined) continue;
    // 項目比較容易誤判：草稿已有項目時，只有在這句話「只」補項目時才覆蓋
    if (key === 'item' && before.item && (parsed.amount || parsed.direction || parsed.date)) continue;
    fields[key] = parsed[key];
  }
  // 追問項目時，使用者常只回一個詞（例如「晚餐」）
  if (!fields.item && before.amount && !parsed.item && text && missingFields(before)[0] === 'item') {
    fields.item = text.slice(0, 30);
  }
  return fields;
}

/**
 * 解析一句話（或一段錄音），並和之前的草稿合併。
 * ctx = { timeZone, me: { nickname, displayName }, partner: { nickname, displayName } }
 * 回傳 { fields, missing, question, source, notice, transcript }
 */
export async function analyze(input, draft, ctx, env = {}, fetchImpl) {
  const today = todayIn(ctx.timeZone);
  const names = buildNames(ctx);
  const before = sanitizeDraft(draft);

  let text = typeof input === 'string' ? input.trim() : (input.text || '').trim();
  const audio = typeof input === 'object' ? input.audio : null;
  const forceRules = FORCE_RULES_PREFIX.test(text);
  text = text.replace(FORCE_RULES_PREFIX, '');

  let parsed = null;
  let source = 'gemini';
  let notice = null;
  let transcript = null;

  if (!forceRules) {
    try {
      const ai = await parseWithGemini(audio ? { audio } : { text }, { today, names }, env, fetchImpl);
      transcript = ai.transcript;
      // 正在追問中（草稿已有內容）時，使用者的回答本來就不完整，不做「是不是借款」的判斷
      const isFollowUp = FIELDS.some((k) => before[k] !== null);
      if (!ai.isLoan && !isFollowUp) {
        const missing = missingFields(before);
        return {
          fields: before,
          missing,
          question: '這句話看起來不像借款（例如請客或送禮）。如果是借款，可以再說清楚一點嗎？🐸',
          source,
          notice,
          transcript,
          today,
        };
      }
      parsed = ai;
    } catch (err) {
      if (!(err instanceof GeminiError)) throw err;
      console.warn('Gemini 失敗，改用規則解析：', err.reason, err.detail || '');
    }
  }

  if (!parsed) {
    if (audio && !text) {
      // 語音只有 Gemini 聽得懂；失敗時請使用者改用文字
      return {
        fields: before,
        missing: missingFields(before),
        question: '小青蛙現在聽不懂語音 😿 請改用打字，或用鍵盤上的麥克風說話。',
        source: 'rules',
        notice: FALLBACK_NOTICE,
        transcript: null,
        today,
      };
    }
    parsed = parseByRules(text, { today, names });
    source = 'rules';
    notice = FALLBACK_NOTICE;
  }

  const fields = merge(before, parsed, text);
  const missing = missingFields(fields);
  return {
    fields,
    missing,
    question: questionFor(missing, ctx.partner.nickname),
    source,
    notice,
    transcript,
    today,
  };
}

function unique(list) {
  return [...new Set(list.map((s) => String(s ?? '').trim()).filter((s) => s.length > 0))]
    // 長的名字先比對，避免「咩咩寶」被「咩咩」搶先
    .sort((a, b) => b.length - a.length);
}
