// 項目分類的自動測試（歷史紀錄 H1）
// 執行方式：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { classify, DEFAULT_CATEGORIES, OTHER, normalize } from '../src/categories.js';

const defaults = [...DEFAULT_CATEGORIES.map((c, i) => ({ ...c, sort_order: i + 1 })), { name: OTHER, keywords: [], sort_order: 99, is_other: true }];

const cases = [
  ['咖啡', '飲料', '基本對應'],
  ['珍珠奶茶', '飲料', '「包含」比對'],
  ['晚餐', '餐飲', '基本對應'],
  ['牛肉麵', '餐飲', '包含「麵」'],
  ['早餐奶茶', '餐飲', '同時符合餐飲與飲料，餐飲排序在前'],
  ['蛋糕', '零食甜點', ''],
  ['計程車', '交通', ''],
  ['ktv 唱歌', '娛樂', '大小寫不同也能對應'],
  ['ＫＴＶ', '娛樂', '全形字也能對應'],
  ['房租', '居家', ''],
  ['掛號費', '醫療', ''],
  ['禮物', '其他', '沒有對應'],
  ['茶葉蛋', '飲料', '已知誤判：包含「茶」'],
  ['炒飯便當', '餐飲', '多個關鍵字同類'],
  ['', '其他', '空白項目'],
];

for (const [item, expected, note] of cases) {
  test(`分類：「${item}」→ ${expected}${note ? `（${note}）` : ''}`, () => {
    assert.equal(classify(item, defaults), expected);
  });
}

test('F6：新增規則「禮物→購物」後，「禮物」歸入購物', () => {
  const rules = defaults.map((c) => (c.name === '購物' ? { ...c, keywords: [...c.keywords, '禮物'] } : c));
  assert.equal(classify('生日禮物', rules), '購物');
});

test('衝突處理看排序：把「零食甜點」調到最前面，加入「茶葉蛋」→ 茶葉蛋改歸零食甜點', () => {
  const rules = defaults.map((c) => (c.name === '零食甜點' ? { ...c, keywords: [...c.keywords, '茶葉蛋'], sort_order: 0 } : c));
  assert.equal(classify('茶葉蛋', rules), '零食甜點');
});

test('空白關鍵字會被忽略（不會讓所有項目都對應到）', () => {
  const rules = [{ name: '測試', keywords: ['', '  '], sort_order: 1 }, { name: OTHER, keywords: [], sort_order: 99, is_other: true }];
  assert.equal(classify('任何東西', rules), OTHER);
});

test('正規化：全形轉半形、英文轉小寫、去頭尾空白', () => {
  assert.equal(normalize('  ＫＴＶ Ａｂｃ '), 'ktv abc');
});

/** 用電腦裡的 SQLite 跑一次所有遷移檔，確認既有資料的處理 */
function migratedDb(beforeHistory) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (f.startsWith('0005')) beforeHistory(db);
    db.exec(readFileSync(new URL(f, dir), 'utf8'));
  }
  return db;
}

test('遷移 0005：既有帳本寫入 9 個分類、既有借款補上分類、已還紀錄的還款人保持「未指定」、舊狀態紀錄保留', () => {
  const db = migratedDb((d) => {
    d.exec(`
      INSERT INTO users (id, google_sub, email) VALUES ('u1','g1','a@example.com'), ('u2','g2','b@example.com');
      INSERT INTO ledgers (id, created_by) VALUES ('L1','u1');
      INSERT INTO ledger_members (ledger_id, user_id, role) VALUES ('L1','u1','owner'), ('L1','u2','member');
      INSERT INTO loans (id, ledger_id, lender_id, borrower_id, amount, item, loan_date, created_by, status)
        VALUES ('a','L1','u1','u2',350,'晚餐','2026-11-18','u1','paid'),
               ('b','L1','u1','u2',120,'珍珠奶茶','2026-11-18','u1','unpaid'),
               ('c','L1','u1','u2',500,'生日禮物','2026-10-01','u1','pending');
      INSERT INTO loan_events (loan_id, ledger_id, actor_id, action) VALUES ('a','L1','u1','create');
    `);
  });
  const cats = db.prepare("SELECT name FROM ledger_categories WHERE ledger_id='L1' ORDER BY sort_order").all().map((r) => r.name);
  assert.deepEqual(cats, ['餐飲', '飲料', '零食甜點', '購物', '交通', '娛樂', '居家', '醫療', '其他']);
  const loans = Object.fromEntries(db.prepare('SELECT id, category, repaid_by FROM loans').all().map((r) => [r.id, r]));
  assert.equal(loans.a.category, '餐飲');
  assert.equal(loans.b.category, '飲料');
  assert.equal(loans.c.category, '其他');
  assert.equal(loans.a.repaid_by, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM loan_events').get().n, 1);
  db.prepare("INSERT INTO loan_events (loan_id, ledger_id, actor_id, action) VALUES ('a','L1','u1','set_repayer')").run();
  assert.throws(() => db.prepare("INSERT INTO loan_events (loan_id, ledger_id, actor_id, action) VALUES ('a','L1','u1','hack')").run(), /CHECK/);
});

test('遷移 0005 寫入的初始分類與程式裡的清單一致', () => {
  const db = migratedDb((d) => {
    d.exec("INSERT INTO users (id, google_sub, email) VALUES ('u1','g1','a@example.com'); INSERT INTO ledgers (id, created_by) VALUES ('L1','u1');");
  });
  const rows = db.prepare("SELECT name, keywords FROM ledger_categories WHERE ledger_id='L1' AND is_other=0 ORDER BY sort_order").all();
  assert.deepEqual(
    rows.map((r) => [r.name, JSON.parse(r.keywords).map(normalize)]),
    DEFAULT_CATEGORIES.map((c) => [c.name, c.keywords.map(normalize)]),
  );
});
