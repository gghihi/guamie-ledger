// 資料庫規則自動測試（第 3 階段起，每次新增遷移檔都會一起測）
// 白話：把資料表建在電腦記憶體裡的一個「練習用資料庫」，故意塞錯誤資料，確認資料庫會擋下來。
// 執行方式：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

// 依序套用所有遷移檔（和雲端資料庫相同的順序）
const dir = new URL('../migrations/', import.meta.url);
const migration = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;'); // Cloudflare D1 預設就會檢查外鍵
  db.exec(migration);
  // 準備三個使用者與一本帳
  for (const [id, name] of [['u1', '呱呱'], ['u2', '咩咩'], ['u3', '路人']]) {
    db.prepare('INSERT INTO users (id, google_sub, email, display_name) VALUES (?, ?, ?, ?)').run(
      id, `g-${id}`, `${id}@example.com`, name,
    );
  }
  db.prepare("INSERT INTO ledgers (id, created_by) VALUES ('L1', 'u1')").run();
  db.prepare("INSERT INTO ledger_members (ledger_id, user_id, role, nickname) VALUES ('L1','u1','owner','呱呱')").run();
  return db;
}

const addLoan = (db, over = {}) => {
  const row = {
    id: 'loan1', ledger_id: 'L1', lender_id: 'u1', borrower_id: 'u2', amount: 350,
    item: '晚餐', loan_date: '2026-11-18', created_by: 'u1', ...over,
  };
  db.prepare(`INSERT INTO loans (id, ledger_id, lender_id, borrower_id, amount, item, loan_date, created_by${row.status ? ', status' : ''})
              VALUES (?, ?, ?, ?, ?, ?, ?, ?${row.status ? ', ?' : ''})`).run(
    row.id, row.ledger_id, row.lender_id, row.borrower_id, row.amount, row.item, row.loan_date, row.created_by,
    ...(row.status ? [row.status] : []),
  );
};

test('所有資料表都建立成功', () => {
  const db = freshDb();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(names, [
    'invite_codes', 'ledger_categories', 'ledger_former_members', 'ledger_members', 'ledgers', 'line_bind_codes', 'line_bindings', 'line_drafts',
    'line_push_usage', 'loan_events', 'loans', 'login_codes', 'push_subscriptions', 'sessions', 'users',
  ]);
});

test('每本帳最多 2 人，第 3 人加入會被拒絕', () => {
  const db = freshDb();
  db.prepare("INSERT INTO ledger_members (ledger_id, user_id, role) VALUES ('L1','u2','member')").run();
  assert.throws(
    () => db.prepare("INSERT INTO ledger_members (ledger_id, user_id, role) VALUES ('L1','u3','member')").run(),
    /ledger_full/,
  );
});

test('新借款預設狀態是「待確認」', () => {
  const db = freshDb();
  addLoan(db);
  assert.equal(db.prepare("SELECT status FROM loans WHERE id='loan1'").get().status, 'pending');
});

test('金額必須大於 0', () => {
  const db = freshDb();
  assert.throws(() => addLoan(db, { amount: 0 }), /CHECK/);
  assert.throws(() => addLoan(db, { amount: -50 }), /CHECK/);
});

test('項目不能空白', () => {
  const db = freshDb();
  assert.throws(() => addLoan(db, { item: '   ' }), /CHECK/);
});

test('日期必須是 YYYY-MM-DD 格式（不能存「昨天」）', () => {
  const db = freshDb();
  assert.throws(() => addLoan(db, { loan_date: '昨天' }), /CHECK/);
  assert.throws(() => addLoan(db, { loan_date: '2026/11/18' }), /CHECK/);
});

test('不能自己借自己', () => {
  const db = freshDb();
  assert.throws(() => addLoan(db, { borrower_id: 'u1' }), /CHECK/);
});

test('不接受規格以外的狀態', () => {
  const db = freshDb();
  assert.throws(() => addLoan(db, { status: 'whatever' }), /CHECK/);
});

test('借款必須屬於存在的帳本', () => {
  const db = freshDb();
  assert.throws(() => addLoan(db, { ledger_id: 'NOPE' }), /FOREIGN KEY/);
});

test('刪除帳本時，該帳本的成員與借款一併清除（不會殘留）', () => {
  const db = freshDb();
  addLoan(db);
  db.prepare("DELETE FROM ledgers WHERE id='L1'").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loans').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_members').get().n, 0);
});

test('狀態紀錄接受「取消還款標記」「還沒收到」兩種新動作', () => {
  const db = freshDb();
  for (const action of ['cancel_repay', 'decline_repay']) {
    db.prepare("INSERT INTO loan_events (loan_id, ledger_id, actor_id, action) VALUES ('x', 'L1', 'u1', ?)").run(action);
  }
  assert.throws(() => db.prepare("INSERT INTO loan_events (loan_id, ledger_id, actor_id, action) VALUES ('x', 'L1', 'u1', 'hack')").run(), /CHECK/);
});
