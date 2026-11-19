// Gemini 語意理解：把一句話（或一段錄音）交給 Google Gemini，請它回傳固定格式的欄位。
// 金鑰只存在後端（Cloudflare 保險箱），前端完全看不到。
// 任何失敗（沒金鑰、額度用完、逾時、回傳格式怪）都丟出 GeminiError，由呼叫端改用規則解析。

import { isValidYmd } from './dates.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiError extends Error {
  constructor(reason, detail) {
    super(`Gemini 無法使用：${reason}`);
    this.reason = reason; // no_key | quota | timeout | http | bad_output | network
    this.detail = detail;
  }
}

// 要求 Gemini 一定要照這個格式回答
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isLoan: { type: 'BOOLEAN', description: '這句話是否在描述一筆借款、代墊或欠款' },
    amount: { type: 'INTEGER', nullable: true, description: '新台幣金額（整數）；不確定就 null' },
    direction: {
      type: 'STRING',
      enum: ['me_lent', 'partner_lent', 'unknown'],
      description: 'me_lent＝使用者借出／代墊（對方欠使用者）；partner_lent＝對方借出／代墊（使用者欠對方）；不確定就 unknown',
    },
    item: { type: 'STRING', nullable: true, description: '簡短項目名稱，例如「晚餐」「計程車」，最多 15 字；不確定就 null' },
    date: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD；句子沒提到日期就 null' },
    transcript: { type: 'STRING', nullable: true, description: '若輸入是語音，填入聽到的文字；文字輸入則 null' },
  },
  required: ['isLoan', 'amount', 'direction', 'item', 'date'],
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function systemPrompt(ctx) {
  const [y, m, d] = ctx.today.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return [
    '你是兩人記帳 APP「呱咩小窩帳」的記帳小幫手，負責從使用者的一句話中擷取借款資料。',
    `今天是 ${ctx.today}（星期${weekday}），時區為台灣。`,
    `使用者本人的稱呼：${ctx.names.me.join('、')}。對方（另一半）的稱呼：${ctx.names.partner.join('、')}。`,
    '規則：',
    '1. 只擷取句子裡明確提到的資訊。不確定的欄位一律填 null 或 unknown，絕對不要猜金額或誰欠誰。',
    '2. direction：使用者幫對方付錢、借錢給對方、對方欠使用者 → me_lent；對方幫使用者付錢、使用者向對方借、使用者欠對方 → partner_lent。',
    '3. 只有明確是「請客」「送禮」「AA 已結清」或與金錢無關的句子，isLoan 才填 false。資訊不完整的句子（例如只有「晚餐三百五」、只有「今天」、只有「咩咩欠我」）仍是借款的一部分，isLoan 填 true，缺的欄位填 null。',
    '4. 「今天、昨天、上週五、18號」等相對日期，請依今天換算成 YYYY-MM-DD；沒提到日期就填 null，不要自動填今天。只說「上禮拜」「前幾天」「最近」等無法確定是哪一天的說法，也填 null。',
    '5. 金額換成新台幣整數，例如「三百五」→350、「1.5萬」→15000。若有多個數字且無法判斷哪個是金額，填 null。',
    '6. item 只寫簡短名詞，不要包含人名、金額、日期。',
  ].join('\n');
}

/**
 * 呼叫 Gemini。input 可以是 { text } 或 { audio: { mimeType, base64 } }（第 10 階段語音用）。
 * 回傳 { amount, direction, item, date, isLoan, transcript }（已檢查過格式）。
 */
export async function parseWithGemini(input, ctx, env, fetchImpl = fetch) {
  if (!env.GEMINI_API_KEY) throw new GeminiError('no_key');
  if (!env.GEMINI_MODEL) throw new GeminiError('no_model');

  // 先用主要模型；忙碌、逾時或出錯時，改用備用模型（兩個都失敗才交給規則解析）
  const attempts = [{ model: env.GEMINI_MODEL, timeout: PRIMARY_TIMEOUT_MS, thinking: true }];
  if (env.GEMINI_FALLBACK_MODEL && env.GEMINI_FALLBACK_MODEL !== env.GEMINI_MODEL) {
    attempts.push({ model: env.GEMINI_FALLBACK_MODEL, timeout: FALLBACK_TIMEOUT_MS, thinking: false });
  }
  let lastError;
  for (const attempt of attempts) {
    try {
      const result = await callModel(input, ctx, env, fetchImpl, attempt);
      return { ...result, model: attempt.model };
    } catch (err) {
      if (!(err instanceof GeminiError)) throw err;
      console.warn(`Gemini 模型 ${attempt.model} 失敗：`, err.reason, err.detail || '');
      lastError = err;
    }
  }
  throw lastError;
}

const PRIMARY_TIMEOUT_MS = 7000;
const FALLBACK_TIMEOUT_MS = 10000;

async function callModel(input, ctx, env, fetchImpl, { model, timeout, thinking }) {
  const parts = input.audio
    ? [{ text: '請聽這段錄音並擷取借款資料。' }, { inlineData: { mimeType: input.audio.mimeType, data: input.audio.base64 } }]
    : [{ text: input.text }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(ctx) }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          // 只有主要模型（Gemini 3.8）使用「低度思考」以加快速度；備用模型用預設值
          ...(thinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new GeminiError(err.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) throw new GeminiError('quota');
  if (!res.ok) {
    // 只記錄狀態碼與錯誤摘要，不記錄使用者輸入的內容
    const text = await res.text().catch(() => '');
    throw new GeminiError('http', `${res.status} ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }

  const data = await res.json().catch(() => null);
  const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  let out;
  try {
    out = JSON.parse(raw);
  } catch {
    throw new GeminiError('bad_output');
  }
  return sanitizeGeminiOutput(out, ctx.today);
}

/** 檢查 Gemini 的回答，不合格的欄位一律改成 null（寧可追問，也不要存錯） */
export function sanitizeGeminiOutput(out, today) {
  if (!out || typeof out !== 'object') throw new GeminiError('bad_output');
  const amount = Number.isInteger(out.amount) && out.amount > 0 && out.amount <= 100000000 ? out.amount : null;
  const direction = ['me_lent', 'partner_lent'].includes(out.direction) ? out.direction : null;
  const item = typeof out.item === 'string' && out.item.trim() ? out.item.trim().slice(0, 30) : null;
  const date = isValidYmd(out.date) && out.date <= today ? out.date : null;
  const transcript = typeof out.transcript === 'string' ? out.transcript.trim().slice(0, 200) : null;
  return { isLoan: out.isLoan !== false, amount, direction, item, date, transcript };
}
