// 直接記帳（花費）解析的自動測試
// 執行方式：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExpenseByRules, analyzeExpense, sanitizeExpenseOutput, missingExpenseFields, sanitizeExpenseDraft,
} from '../src/parse/expense.js';
import { todayIn } from '../src/parse/dates.js';

const TODAY = '2026-11-26';
const rulesCtx = { today: TODAY, names: { me: ['我', '呱呱'], partner: ['咩咩', '她', '他', '對方'] } };

test('規則解析：金額、誰付的、項目、日期', () => {
  assert.deepEqual(parseExpenseByRules('咩咩今天買菜 500', rulesCtx), { amount: 500, payer: 'partner', item: '買菜', date: '2026-11-26' });
  assert.deepEqual(parseExpenseByRules('我付電費 1200', rulesCtx), { amount: 1200, payer: 'me', item: '電費', date: null });
  assert.deepEqual(parseExpenseByRules('昨天她花了三百五吃早餐', rulesCtx), { amount: 350, payer: 'partner', item: '吃早餐', date: '2026-11-25' });
});

test('規則解析：沒說誰付的就留空（不亂猜）', () => {
  assert.deepEqual(parseExpenseByRules('晚餐 600', rulesCtx), { amount: 600, payer: null, item: '晚餐', date: null });
});

test('欄位檢查與整理', () => {
  assert.deepEqual(missingExpenseFields({ amount: null, payer: null, item: null, date: null }), ['amount', 'payer', 'item', 'date']);
  assert.deepEqual(missingExpenseFields({ amount: 1, payer: 'me', item: 'x', date: TODAY }), []);
  assert.deepEqual(sanitizeExpenseDraft({ amount: '12', payer: 'boss', item: '  ', date: '昨天' }), { amount: 12, payer: null, item: null, date: null });
});

const ctx = { timeZone: 'Asia/Taipei', me: { nickname: '呱呱', displayName: '測試' }, partner: { nickname: '咩咩', displayName: '測試2' } };
const env = { GEMINI_API_KEY: 'fake-key', GEMINI_MODEL: 'gemini-3.8-flash' };
const today = todayIn('Asia/Taipei');
const fakeGemini = (answer, status = 200) => async (url, init) => {
  fakeGemini.last = JSON.parse(init.body);
  return status !== 200
    ? new Response('error', { status })
    : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }), { status: 200 });
};

test('Gemini：用「花費」格式問，結果合併成草稿並追問缺的欄位', async () => {
  const r = await analyzeExpense('買菜 500', null, ctx, env, fakeGemini({ isExpense: true, amount: 500, payer: 'unknown', item: '買菜', date: null }));
  assert.equal(r.source, 'gemini');
  assert.deepEqual(r.fields, { amount: 500, payer: null, item: '買菜', date: null });
  assert.deepEqual(r.missing, ['payer', 'date']);
  assert.match(r.question, /誰付的/);
  assert.ok(fakeGemini.last.generationConfig.responseSchema.properties.payer, '要用花費的回答格式');
  assert.match(fakeGemini.last.systemInstruction.parts[0].text, /直接記帳/);
});

test('Gemini 失敗 → 改用規則解析並顯示備用提示', async () => {
  const r = await analyzeExpense('咩咩今天買菜 500', null, ctx, env, fakeGemini(null, 500));
  assert.equal(r.source, 'rules');
  assert.equal(r.notice, '目前使用備用解析');
  assert.equal(r.fields.payer, 'partner');
  assert.equal(r.fields.amount, 500);
});

test('追問時只回一個詞就當作項目；回答誰付的會補進草稿', async () => {
  const draft = { amount: 500, payer: 'me', item: null, date: today };
  const r = await analyzeExpense('#備用 衛生紙', draft, ctx, env);
  assert.equal(r.fields.item, '衛生紙');
  assert.deepEqual(r.missing, []);
});

test('Gemini 回答不合格的欄位一律改成空白', () => {
  const out = sanitizeExpenseOutput({ isExpense: true, amount: -1, payer: 'boss', item: ' ', date: '2999-01-01' }, today);
  assert.deepEqual({ amount: out.amount, payer: out.payer, item: out.item, date: out.date }, { amount: null, payer: null, item: null, date: null });
});
