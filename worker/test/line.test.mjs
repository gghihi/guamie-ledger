// LINE 機器人的自動測試（第 12 階段）
// 執行方式：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { verifySignature, draftMessage } from '../src/line.js';
import { takeMonthlyQuota, notifyLine } from '../src/lineApi.js';

/** 用電腦裡的 SQLite 模擬 Cloudflare D1 的寫法（prepare → bind → first/run/all） */
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind: (...a) => { args = a; return stmt; },
      first: async () => db.prepare(sql).get(...args) ?? null,
      run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
      all: async () => ({ results: db.prepare(sql).all(...args) }),
    };
    return stmt;
  };
  return { prepare, raw: db };
}

test('簽章：正確的通過、被改過的內容或錯的鑰匙都不通過', async () => {
  const body = JSON.stringify({ events: [{ type: 'message' }] });
  const sig = createHmac('sha256', 'secret').update(body).digest('base64');
  assert.equal(await verifySignature('secret', body, sig), true);
  assert.equal(await verifySignature('secret', body.replace('message', 'hacked'), sig), false);
  assert.equal(await verifySignature('other', body, sig), false);
  assert.equal(await verifySignature('secret', body, null), false);
});

const lc = { partner: { nickname: '咩咩' } };
const env = { APP_TIMEZONE: 'Asia/Taipei' };

test('LINE 草稿訊息：缺「誰欠誰」時附上兩個選項按鈕與取消', () => {
  const m = draftMessage(env, lc, { amount: 350, direction: null, item: '晚餐', date: '2026-11-18' }, {});
  assert.equal(m.type, 'text');
  assert.match(m.text, /\$350/);
  const labels = m.quickReply.items.map((i) => i.action.label);
  assert.deepEqual(labels.slice(0, 2), ['我借給咩咩', '咩咩借給我']);
  assert.ok(labels.includes('取消這筆'));
});

test('LINE 草稿訊息：只缺日期時附上今天／昨天／前天', () => {
  const m = draftMessage(env, lc, { amount: 350, direction: 'me_lent', item: '晚餐', date: null }, {});
  const labels = m.quickReply.items.map((i) => i.action.label);
  assert.ok(['今天', '昨天', '前天'].every((x) => labels.includes(x)));
});

test('LINE 草稿訊息：欄位齊全 → 「確認送出／取消」確認畫面', () => {
  const m = draftMessage(env, lc, { amount: 350, direction: 'me_lent', item: '晚餐', date: '2026-11-18' }, { notice: '目前使用備用解析' });
  assert.equal(m.template.type, 'confirm');
  assert.deepEqual(m.template.actions.map((a) => a.data), ['a=confirm', 'a=cancel']);
  assert.ok(m.template.text.length <= 240);
  assert.match(m.template.text, /咩咩欠你/);
});

test('每月 LINE 通知額度：到上限就停止，不會超發', async () => {
  const DB = fakeD1();
  const e = { DB, APP_TIMEZONE: 'Asia/Taipei', LINE_MONTHLY_PUSH_LIMIT: '3' };
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await takeMonthlyQuota(e));
  assert.deepEqual(results, [true, true, true, false, false]);
});

test('LINE 通知：沒綁定不送；有綁定時，新帳通知附「同意／否定」按鈕', async () => {
  const DB = fakeD1();
  DB.raw.exec("INSERT INTO users (id, google_sub, email) VALUES ('u1','g1','a@example.com')");
  const sent = [];
  const e = {
    DB, APP_TIMEZONE: 'Asia/Taipei', LINE_CHANNEL_ACCESS_TOKEN: 't',
    lineFetch: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); },
  };
  assert.equal(await notifyLine(e, { toUserId: 'u1', type: 'new_pending', loanId: 'L', body: 'hi' }), 'not_bound');
  DB.raw.exec("INSERT INTO line_bindings (line_user_id, user_id) VALUES ('Uxxx','u1')");
  assert.equal(await notifyLine(e, { toUserId: 'u1', type: 'new_pending', loanId: 'L', body: '📒 新帳' }), 'ok');
  assert.match(sent[0].url, /\/message\/push$/);
  assert.equal(sent[0].body.to, 'Uxxx');
  assert.deepEqual(sent[0].body.messages[0].template.actions.map((a) => a.label), ['同意', '否定']);
});
