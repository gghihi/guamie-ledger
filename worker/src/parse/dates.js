// 相對日期轉換：把「今天、昨天、上週五、11/18」等說法換成實際日期（YYYY-MM-DD）
// 一律以台灣時間計算「今天」。
// 這個檔案不依賴 Cloudflare，可以直接在電腦上做自動測試。

/** 取得某時區的「今天」，回傳 YYYY-MM-DD */
export function todayIn(timeZone = 'Asia/Taipei', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// ── 日期小工具（用 UTC 計算，避免時區干擾） ──
const toUtc = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmt = (date) => date.toISOString().slice(0, 10);
const addDays = (ymd, n) => {
  const d = toUtc(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
};
/** 星期幾：週一=1 … 週日=7 */
const isoWeekday = (ymd) => toUtc(ymd).getUTCDay() || 7;

/** 檢查年月日是否為真實存在的日期 */
export function makeDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null; // 例如 2 月 30 日
  return fmt(date);
}

export const isValidYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && makeDate(...s.split('-').map(Number)) === s;

const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 末: 6 };
const CN_DIGIT = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 「三」「十」「12」→ 數字（只處理日期用到的小數字） */
function smallNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1) return CN_DIGIT[s] ?? null;
  // 十一～三十一
  const m = s.match(/^([二兩三])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
  return null;
}

const NUM = '(\\d{1,2}|[一二兩三四五六七八九十]{1,3})';

/**
 * 從句子裡找出日期。
 * 回傳 { date: 'YYYY-MM-DD', text: '原句中被認出的字' }；找不到回傳 null。
 * 沒寫年份、而日期比今天晚時，視為去年（例如 1 月說「12/28」）。
 */
export function findDate(sentence, today) {
  const s = sentence;
  const rules = [
    // 2026-11-18、2026/11/18、2026.11.18、2026年11月18日
    [/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日號号]?/, (m) => makeDate(+m[1], +m[2], +m[3])],
    // 大前天、前天、昨天、今天、明天
    [/大前天/, () => addDays(today, -3)],
    [/前天/, () => addDays(today, -2)],
    [/(昨天|昨日|昨晚|昨夜)/, () => addDays(today, -1)],
    [/(今天|今日|今晚|今早|剛剛|剛才)/, () => today],
    [/(明天|明日)/, () => addDays(today, 1)],
    // 3 天前、三天前
    [new RegExp(`${NUM}\\s*天前`), (m) => {
      const n = smallNumber(m[1]);
      return n ? addDays(today, -n) : null;
    }],
    // 上上週五、上週五、上禮拜五、上星期五
    [/(上上|上)(?:週|周|禮拜|星期|个?星期)([一二三四五六日天])/, (m) => {
      const weeksBack = m[1] === '上上' ? 2 : 1;
      const monday = addDays(today, -(isoWeekday(today) - 1) - 7 * weeksBack);
      return addDays(monday, WEEKDAY[m[2]] - 1);
    }],
    // 這週五、本週五（可能是未來）
    [/(?:這|这|本)(?:週|周|禮拜|星期)([一二三四五六日天])/, (m) => {
      const monday = addDays(today, -(isoWeekday(today) - 1));
      return addDays(monday, WEEKDAY[m[1]] - 1);
    }],
    // 週五、禮拜五、星期五（最近一次，包含今天）
    [/(?:週|周|禮拜|星期)([一二三四五六日天])/, (m) => {
      const diff = (isoWeekday(today) - WEEKDAY[m[1]] + 7) % 7;
      return addDays(today, -diff);
    }],
    // 上個月 5 號
    [new RegExp(`上個?月\\s*${NUM}\\s*[日號号]`), (m) => {
      const [y, mo] = today.split('-').map(Number);
      const d = smallNumber(m[1]);
      return mo === 1 ? makeDate(y - 1, 12, d) : makeDate(y, mo - 1, d);
    }],
    // 11月18日、11月18號、11/18
    [new RegExp(`${NUM}\\s*月\\s*${NUM}\\s*[日號号]?`), (m) => withYear(today, smallNumber(m[1]), smallNumber(m[2]))],
    [/(?<![\d.])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/, (m) => withYear(today, +m[1], +m[2])],
    // 18號、18日（本月；比今天晚就算上個月）
    [new RegExp(`(?<![月\\d])${NUM}\\s*[號号日](?!本)`), (m) => {
      const [y, mo] = today.split('-').map(Number);
      const d = smallNumber(m[1]);
      const thisMonth = makeDate(y, mo, d);
      if (thisMonth && thisMonth <= today) return thisMonth;
      return mo === 1 ? makeDate(y - 1, 12, d) : makeDate(y, mo - 1, d);
    }],
  ];

  for (const [re, resolve] of rules) {
    const m = s.match(re);
    if (!m) continue;
    const date = resolve(m);
    if (date) return { date, text: m[0] };
  }
  return null;
}

/** 沒寫年份的月日：今年；若比今天晚則算去年 */
function withYear(today, month, day) {
  const year = Number(today.slice(0, 4));
  const thisYear = makeDate(year, month, day);
  if (!thisYear) return null;
  return thisYear <= today ? thisYear : makeDate(year - 1, month, day);
}
