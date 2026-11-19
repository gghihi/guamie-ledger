// Gemini 與備用機制的自動測試（第 6 階段）
// 用「假的 Gemini」模擬各種情況，不會真的連到 Google，也不會花到額度。
// 執行方式：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, FALLBACK_NOTICE } from '../src/parse/index.js';
import { sanitizeGeminiOutput } from '../src/parse/gemini.js';
import { todayIn } from '../src/parse/dates.js';

const ctx = { timeZone: 'Asia/Taipei', me: { nickname: '呱呱', displayName: '測試' }, partner: { nickname: '咩咩', displayName: '測試2' } };
const env = { GEMINI_API_KEY: 'fake-key', GEMINI_MODEL: 'gemini-3.8-flash' };
const today = todayIn('Asia/Taipei');

/** 產生一個假的 Gemini：回傳指定的 JSON，並記錄收到的請求 */
function fakeGemini(answer, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (status !== 200) return new Response('error', { status });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }), { status: 200 });
  };
  impl.calls = calls;
  return impl;
}

test('Gemini 正常：使用 Gemini 的結果，不顯示備用提示', async () => {
  const fake = fakeGemini({ isLoan: true, amount: 2000, direction: 'me_lent', item: '買鞋', date: today });
  const r = await analyze('咩咩前幾天跟我拿了兩千去買鞋子', null, ctx, env, fake);
  assert.equal(r.source, 'gemini');
  assert.equal(r.notice, null);
  assert.deepEqual(r.fields, { amount: 2000, direction: 'me_lent', item: '買鞋', date: today });
});

test('呼叫 Gemini 時：模型名稱來自設定、金鑰放在標頭（不在網址）', async () => {
  const fake = fakeGemini({ isLoan: true, amount: 1, direction: 'me_lent', item: 'x', date: today });
  await analyze('test', null, ctx, env, fake);
  const { url, init } = fake.calls[0];
  assert.match(url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.ok(!url.includes('fake-key'));
  assert.equal(init.headers['x-goog-api-key'], 'fake-key');
});

test('Gemini 額度用完（429）→ 自動改用規則解析並提示', async () => {
  const r = await analyze('昨天幫咩咩付晚餐 350', null, ctx, env, fakeGemini(null, { status: 429 }));
  assert.equal(r.source, 'rules');
  assert.equal(r.notice, FALLBACK_NOTICE);
  assert.equal(r.fields.amount, 350);
  assert.equal(r.fields.direction, 'me_lent');
});

test('Gemini 伺服器錯誤（500）→ 改用規則解析', async () => {
  const r = await analyze('晚餐 350', null, ctx, env, fakeGemini(null, { status: 500 }));
  assert.equal(r.source, 'rules');
  assert.equal(r.notice, FALLBACK_NOTICE);
});

test('Gemini 連線失敗或逾時 → 改用規則解析', async () => {
  const broken = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  const r = await analyze('晚餐 350', null, ctx, env, broken);
  assert.equal(r.source, 'rules');
});

test('沒有設定金鑰 → 直接用規則解析', async () => {
  const r = await analyze('晚餐 350', null, ctx, { GEMINI_MODEL: 'x' }, fakeGemini({}));
  assert.equal(r.source, 'rules');
});

test('Gemini 回傳亂七八糟的內容 → 改用規則解析', async () => {
  const garbage = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '我不知道' }] } }] }));
  const r = await analyze('晚餐 350', null, ctx, env, garbage);
  assert.equal(r.source, 'rules');
});

test('測試開關：句子開頭打「#備用」→ 不呼叫 Gemini', async () => {
  const fake = fakeGemini({ isLoan: true, amount: 999, direction: 'me_lent', item: 'x', date: today });
  const r = await analyze('#備用 晚餐 350', null, ctx, env, fake);
  assert.equal(fake.calls.length, 0);
  assert.equal(r.source, 'rules');
  assert.equal(r.fields.amount, 350);
  assert.equal(r.fields.item, '晚餐');
});

test('Gemini 不確定的欄位留空 → 一樣會追問', async () => {
  const fake = fakeGemini({ isLoan: true, amount: 350, direction: 'unknown', item: '晚餐', date: null });
  const r = await analyze('晚餐三百五', null, ctx, env, fake);
  assert.deepEqual(r.missing, ['direction', 'date']);
  assert.match(r.question, /借給/);
});

test('Gemini 判斷不是借款（請客）→ 不填欄位，請使用者說清楚', async () => {
  const fake = fakeGemini({ isLoan: false, amount: 500, direction: 'unknown', item: '吃飯', date: today });
  const r = await analyze('咩咩請我吃飯', null, ctx, env, fake);
  assert.equal(r.fields.amount, null);
  assert.match(r.question, /不像借款/);
});

test('主要模型忙碌（503）→ 改用備用模型，仍算 Gemini 解析', async () => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url.includes('gemini-3.8-flash')) return new Response('busy', { status: 503 });
    const answer = { isLoan: true, amount: 350, direction: 'me_lent', item: '晚餐', date: today };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }));
  };
  const r = await analyze('今天幫咩咩付晚餐 350', null, ctx, { ...env, GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite' }, impl);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /gemini-3\.5-flash-lite/);
  assert.equal(r.source, 'gemini');
  assert.equal(r.notice, null);
  assert.equal(r.fields.amount, 350);
});

test('主要與備用模型都失敗 → 才改用規則解析', async () => {
  const r = await analyze('晚餐 350', null, ctx, { ...env, GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite' }, fakeGemini(null, { status: 503 }));
  assert.equal(r.source, 'rules');
  assert.equal(r.notice, FALLBACK_NOTICE);
});

test('追問中回答「今天」時，就算 Gemini 說不像借款也照樣補欄位', async () => {
  const fake = fakeGemini({ isLoan: false, amount: null, direction: 'unknown', item: null, date: today });
  const r = await analyze('今天', { amount: 350, direction: 'me_lent', item: '晚餐', date: null }, ctx, env, fake);
  assert.equal(r.fields.date, today);
  assert.deepEqual(r.missing, []);
});

test('語音：錄音以 inlineData 送給 Gemini，並帶回聽到的文字', async () => {
  const fake = fakeGemini({ isLoan: true, amount: 120, direction: 'partner_lent', item: '咖啡', date: today, transcript: '今天咩咩幫我付咖啡一百二' });
  const r = await analyze({ audio: { mimeType: 'audio/wav', base64: 'UklGRg==' } }, null, ctx, env, fake);
  const sent = JSON.parse(fake.calls[0].init.body);
  assert.equal(sent.contents[0].parts[1].inlineData.mimeType, 'audio/wav');
  assert.equal(r.transcript, '今天咩咩幫我付咖啡一百二');
  assert.equal(r.fields.amount, 120);
  assert.equal(r.source, 'gemini');
});

test('語音：Gemini 無法使用時，請使用者改用打字（規則解析聽不懂聲音）', async () => {
  const r = await analyze({ audio: { mimeType: 'audio/wav', base64: 'UklGRg==' } }, null, ctx, env, fakeGemini(null, { status: 429 }));
  assert.equal(r.notice, FALLBACK_NOTICE);
  assert.match(r.question, /打字|鍵盤/);
  assert.equal(r.fields.amount, null);
});

test('金鑰前面有看不見的字元（BOM）或換行 → 自動去掉再送出', async () => {
  const fake = fakeGemini({ isLoan: true, amount: 1, direction: 'me_lent', item: 'x', date: today });
  await analyze('test', null, ctx, { ...env, GEMINI_API_KEY: '﻿fake-key\r\n' }, fake);
  assert.equal(fake.calls[0].init.headers['x-goog-api-key'], 'fake-key');
});

test('檢查 Gemini 的回答：負數、未來日期、錯誤方向都會被清掉', () => {
  const out = sanitizeGeminiOutput({ isLoan: true, amount: -5, direction: 'whatever', item: '  ', date: '2999-01-01' }, today);
  assert.deepEqual({ amount: out.amount, direction: out.direction, item: out.item, date: out.date }, { amount: null, direction: null, item: null, date: null });
});
