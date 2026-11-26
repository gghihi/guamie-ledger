// 規則解析（備用方案）：不靠 AI，用固定句型抓出「金額、誰欠誰、項目、日期」。
// 原則：看不懂就留空、交給追問，絕不自己猜金額或對象。
// 這個檔案不依賴 Cloudflare，可以直接在電腦上做自動測試。

import { findDate } from './dates.js';

/** 方向：me_lent＝我借出（對方欠我）；partner_lent＝對方借出（我欠對方） */
export const DIRECTIONS = ['me_lent', 'partner_lent'];

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── 中文數字 → 阿拉伯數字 ──
const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };

/** 「三百五」→350、「一千二」→1200、「兩萬五」→25000、「十五」→15 */
export function chineseToNumber(text) {
  let total = 0;
  let section = 0;
  let digit = null;
  let lastUnit = 0;
  let prevWasUnit = false;
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch];
      prevWasUnit = false;
    } else if (ch in CN_UNITS) {
      section += (digit ?? 1) * CN_UNITS[ch];
      lastUnit = CN_UNITS[ch];
      digit = null;
      prevWasUnit = true;
    } else if (ch === '萬' || ch === '万') {
      total += (section + (digit ?? 0)) * 10000 || 10000;
      section = 0;
      digit = null;
      lastUnit = 10000;
      prevWasUnit = true;
    } else {
      return null;
    }
  }
  if (digit !== null) {
    // 口語省略：「三百五」的「五」代表 50
    const shorthand = !prevWasUnit && lastUnit >= 100 && text.length >= 3 && !/[零〇]/.test(text.slice(-2, -1));
    section += shorthand ? digit * (lastUnit / 10) : digit;
  }
  return total + section;
}

/**
 * 找金額。
 * 規則：阿拉伯數字（可帶 元/塊/$/萬/千/k），或含單位的中文數字（例如 三百五、兩千）。
 * 如果出現兩個以上「沒有標示是錢」的數字，就不猜，回傳 null 讓系統追問。
 */
export function findAmount(text) {
  const candidates = [];
  const arabic = /(?:NT\$?|\$|＄)?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(萬|万|千|k|K)?\s*(元|塊|块|圓|圆|塊錢|元整)?/g;
  for (const m of text.matchAll(arabic)) {
    let value = Number(m[1].replace(/,/g, ''));
    if (m[2] === '萬' || m[2] === '万') value *= 10000;
    else if (m[2]) value *= 1000;
    const marked = /\$|＄|NT/.test(m[0]) || Boolean(m[3]) || Boolean(m[2]);
    candidates.push({ value, text: m[0].trim(), marked });
  }
  // 中文數字必須以數字或「十」開頭（避免「1.5萬」裡的「萬」被重複算一次）
  const chinese = /(?<![\d.])[零〇一二兩两三四五六七八九十][零〇一二兩两三四五六七八九十百千萬万]*(?:元|塊|块|圓|圆)?/g;
  for (const m of text.matchAll(chinese)) {
    const word = m[0].replace(/(元|塊|块|圓|圆)$/, '');
    const hasUnit = /[十百千萬万]/.test(word);
    const marked = word.length !== m[0].length;
    if (!hasUnit && !marked) continue; // 「一杯」「兩個」不是金額
    const value = chineseToNumber(word);
    if (value) candidates.push({ value, text: m[0], marked: marked || /[百千萬万]/.test(word) });
  }

  const valid = candidates.filter((c) => Number.isFinite(c.value) && c.value > 0);
  const marked = valid.filter((c) => c.marked);
  const pick = marked.length === 1 ? marked[0] : marked.length === 0 && valid.length === 1 ? valid[0] : null;
  if (!pick || !Number.isInteger(pick.value) || pick.value > 100000000) return null;
  return { amount: pick.value, text: pick.text };
}

/**
 * 找「誰欠誰」。
 * names.me：代表自己的詞（我、自己的暱稱）；names.partner：代表對方的詞（暱稱、他、她、對方）。
 */
export function findDirection(text, names) {
  const ME = `(?:${names.me.map(escapeRe).join('|')})`;
  const P = `(?:${names.partner.map(escapeRe).join('|')})`;
  // 注意：「請」（請客）不算借錢，所以不放進來
  const PAY = '(?:付|墊|垫|出|買|买|繳|缴|代墊|代付)';
  // 由上往下比對，越明確的句型越前面
  const rules = [
    [`${P}(?:跟|向|找)${ME}借`, 'me_lent'],
    [`${ME}(?:跟|向|找)${P}借`, 'partner_lent'],
    [`${P}(?:先)?借(?:給|给)?${ME}`, 'partner_lent'],
    [`${ME}(?:先)?借(?:給|给)?${P}`, 'me_lent'],
    [`${P}(?:幫|帮|替)${ME}(?:先)?${PAY}`, 'partner_lent'],
    [`${ME}?(?:幫|帮|替)${P}(?:先)?${PAY}`, 'me_lent'],
    [`${P}(?:還)?欠${ME}`, 'me_lent'],
    [`${ME}(?:還)?欠${P}`, 'partner_lent'],
    [`借(?:給|给)${P}`, 'me_lent'],
    [`(?:跟|向)${P}借`, 'partner_lent'],
  ];
  for (const [pattern, direction] of rules) {
    // 允許詞與詞之間有空格，例如「咩咩 跟我借」
    const m = text.match(new RegExp(pattern.replace(/\)(?=\(|跟|向|找|借|幫|帮|替|欠)/g, ')\\s*')));
    if (m) return { direction, text: m[0] };
  }
  return null;
}

// 整理項目時要拿掉的贅字
const FILLER = /^(?:了|的|錢|钱|塊|元|給|给|去|來|来|在|是|把|用|共|總共|一共|，|,|。|\s)+|(?:了|的|錢|钱|喔|哦|啦|吧|呢|耶|，|,|。|！|!|\s)+$/g;

export function cleanItem(rest) {
  let item = rest.replace(/[，,。！!？?、~～\s]+/g, ' ').trim();
  let prev;
  do {
    prev = item;
    item = item.replace(FILLER, '').trim();
  } while (item !== prev);
  // 只剩符號或太短的字就當作沒有
  if (!/[\p{L}]/u.test(item)) return null;
  return item.slice(0, 30);
}

/**
 * 解析一句話。
 * ctx = { today: 'YYYY-MM-DD', names: { me: [...], partner: [...] } }
 * 回傳 { amount, direction, item, date }，看不懂的欄位為 null。
 */
export function parseByRules(input, ctx) {
  let text = String(input ?? '').normalize('NFKC').trim();
  const result = { amount: null, direction: null, item: null, date: null };
  if (!text) return result;

  // 依序找出並「挖掉」日期 → 方向 → 金額，剩下的字就是項目
  const date = findDate(text, ctx.today);
  if (date) {
    result.date = date.date;
    text = text.replace(date.text, '');
  }
  const direction = findDirection(text, ctx.names);
  if (direction) {
    result.direction = direction.direction;
    text = text.replace(direction.text, ' ');
  }
  const amount = findAmount(text);
  if (amount) {
    result.amount = amount.amount;
    text = text.replace(amount.text, ' ');
  }

  // 剩下的字裡若還有對方或自己的名字，拿掉（例如「呱呱 晚餐」）
  for (const name of [...ctx.names.partner, ...ctx.names.me]) {
    text = text.split(name).join(' ');
  }
  // 常見動詞殘骸
  text = text.replace(/(?:幫|帮|替|付|墊|垫|借|欠|還|还|跟|向|先)(?=\s|$)/g, ' ');
  result.item = cleanItem(text);
  return result;
}
