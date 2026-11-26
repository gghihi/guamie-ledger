// 規則解析與日期轉換的自動測試（第 5 階段）
// 執行方式：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDate, todayIn } from '../src/parse/dates.js';
import { parseByRules, chineseToNumber, findAmount, findPaid } from '../src/parse/rules.js';

// 假設今天是 2026-11-19（星期四）
const TODAY = '2026-11-19';
const ctx = { today: TODAY, names: { me: ['我', '呱呱'], partner: ['咩咩', '他', '她', '對方'] } };
const d = (s) => findDate(s, TODAY)?.date ?? null;

test('台灣時間的「今天」', () => {
  // 2026-11-19 20:00 UTC 在台灣已經是 11/20
  assert.equal(todayIn('Asia/Taipei', new Date('2026-11-19T20:00:00Z')), '2026-11-20');
});

test('相對日期：今天、昨天、前天、大前天、N 天前', () => {
  assert.equal(d('今天'), '2026-11-19');
  assert.equal(d('昨天'), '2026-11-18');
  assert.equal(d('昨晚'), '2026-11-18');
  assert.equal(d('前天'), '2026-11-17');
  assert.equal(d('大前天'), '2026-11-16');
  assert.equal(d('3天前'), '2026-11-16');
  assert.equal(d('五天前'), '2026-11-14');
});

test('星期：上週五、上禮拜一、這週一、週二、星期日', () => {
  assert.equal(d('上週五'), '2026-11-13');
  assert.equal(d('上禮拜一'), '2026-11-09');
  assert.equal(d('上上週三'), '2026-11-04');
  assert.equal(d('這週一'), '2026-11-16');
  assert.equal(d('週二'), '2026-11-17');
  assert.equal(d('週四'), '2026-11-19'); // 今天就是週四
  assert.equal(d('星期日'), '2026-11-15');
});

test('月日：11/18、11月3號、18號、上個月5號、跨年', () => {
  assert.equal(d('11/18'), '2026-11-18');
  assert.equal(d('11月3號'), '2026-11-03');
  assert.equal(d('十一月三日'), '2026-11-03');
  assert.equal(d('18號'), '2026-11-18');
  assert.equal(d('25號'), '2026-10-25'); // 比今天晚 → 上個月
  assert.equal(d('上個月5號'), '2026-10-05');
  assert.equal(d('12/25'), '2025-12-25'); // 比今天晚 → 去年
  assert.equal(d('2026-01-02'), '2026-01-02');
  assert.equal(d('2026年2月30日'), null); // 不存在的日期
});

test('中文數字', () => {
  assert.equal(chineseToNumber('三百五'), 350);
  assert.equal(chineseToNumber('一千二'), 1200);
  assert.equal(chineseToNumber('兩千'), 2000);
  assert.equal(chineseToNumber('兩萬五'), 25000);
  assert.equal(chineseToNumber('十五'), 15);
  assert.equal(chineseToNumber('一千零五'), 1005);
  assert.equal(chineseToNumber('三百'), 300);
});

test('金額：多個沒標示的數字時不猜', () => {
  assert.equal(findAmount('晚餐 350')?.amount, 350);
  assert.equal(findAmount('$1,200')?.amount, 1200);
  assert.equal(findAmount('1.5萬')?.amount, 15000);
  assert.equal(findAmount('三百五十元')?.amount, 350);
  assert.equal(findAmount('3杯咖啡 150元')?.amount, 150); // 有「元」的那個
  assert.equal(findAmount('3杯咖啡 150'), null); // 兩個數字都沒標示 → 追問
  assert.equal(findAmount('一杯咖啡'), null); // 「一杯」不是金額
});

const cases = [
  ['昨天幫咩咩付晚餐 350', { amount: 350, direction: 'me_lent', item: '晚餐', date: '2026-11-18' }],
  ['咩咩上禮拜五跟我借了兩千買鞋', { amount: 2000, direction: 'me_lent', item: '買鞋', date: '2026-11-13' }],
  ['今天咩咩幫我付咖啡120元', { amount: 120, direction: 'partner_lent', item: '咖啡', date: '2026-11-19' }],
  ['我跟咩咩借500 計程車 今天', { amount: 500, direction: 'partner_lent', item: '計程車', date: '2026-11-19' }],
  ['咩咩欠我電影票 560 11/15', { amount: 560, direction: 'me_lent', item: '電影票', date: '2026-11-15' }],
  ['我欠咩咩三百五 早餐 前天', { amount: 350, direction: 'partner_lent', item: '早餐', date: '2026-11-17' }],
  ['借給他 1000 房租 18號', { amount: 1000, direction: 'me_lent', item: '房租', date: '2026-11-18' }],
  ['呱呱借咩咩800元 買菜 昨天', { amount: 800, direction: 'me_lent', item: '買菜', date: '2026-11-18' }],
];

for (const [sentence, expected] of cases) {
  test(`解析：「${sentence}」`, () => {
    assert.deepEqual(parseByRules(sentence, ctx), expected);
  });
}

test('缺漏：只說「晚餐 350」→ 金額與項目有，方向與日期留空', () => {
  assert.deepEqual(parseByRules('晚餐 350', ctx), { amount: 350, direction: null, item: '晚餐', date: null });
});

test('看不懂的句子：全部留空，不亂猜', () => {
  const r = parseByRules('那個錢啊', ctx);
  assert.equal(r.amount, null);
  assert.equal(r.direction, null);
});

test('請客不算借錢：「咩咩請我吃飯 500」方向留空', () => {
  assert.equal(parseByRules('咩咩請我吃飯 500', ctx).direction, null);
});

test('「已經還了」：直接記入已還的說法', () => {
  assert.ok(findPaid('她已經還我了'));
  assert.ok(findPaid('咖啡 120 還清了'));
  assert.ok(findPaid('已結清'));
  assert.equal(findPaid('晚餐 350 還沒還'), null);
  assert.equal(findPaid('她沒有還我'), null);
  assert.equal(findPaid('咩咩已付晚餐 300'), null); // 「已付」是代墊，不是還款
  assert.equal(findPaid('我還要付房租'), null);
  const r = parseByRules('昨天幫咩咩付晚餐 350，她已經還我了', ctx);
  assert.equal(r.alreadyPaid, true);
  assert.equal(r.item, '晚餐');
  assert.equal(r.amount, 350);
  assert.equal(parseByRules('昨天幫咩咩付晚餐 350', ctx).alreadyPaid, undefined);
});
