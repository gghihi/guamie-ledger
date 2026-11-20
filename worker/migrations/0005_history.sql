-- 歷史紀錄功能（H1）
-- 白話：
--  1. 每筆借款多記「實際還款人」和「分類」
--  2. 每本帳有自己的一份分類規則（初始 9 類）
--  3. 狀態紀錄可以記「補填還款人」
-- 全部都是「新增」，不刪除、不改動既有資料。

-- ── 1. 借款新增欄位 ──
ALTER TABLE loans ADD COLUMN repaid_by TEXT REFERENCES users(id);   -- 實際還款人；空白＝未指定
ALTER TABLE loans ADD COLUMN category TEXT;                          -- 記帳當下決定的分類名稱
CREATE INDEX idx_loans_ledger_status_date ON loans(ledger_id, status, loan_date);

-- ── 2. 每本帳的分類規則 ──
CREATE TABLE ledger_categories (
  id          TEXT PRIMARY KEY,
  ledger_id   TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 12),
  keywords    TEXT NOT NULL DEFAULT '[]',        -- JSON 陣列，例如 ["早餐","午餐"]
  sort_order  INTEGER NOT NULL,                  -- 數字小的優先（同時符合多類時用）
  is_other    INTEGER NOT NULL DEFAULT 0 CHECK (is_other IN (0, 1)),
  UNIQUE (ledger_id, name)
);
CREATE INDEX idx_categories_ledger ON ledger_categories(ledger_id, sort_order);

-- 既有帳本：寫入初始 9 類（之後新建的帳本由程式寫入，內容同 src/categories.js）
INSERT INTO ledger_categories (id, ledger_id, name, keywords, sort_order, is_other)
  SELECT lower(hex(randomblob(16))), id, '餐飲', '["早餐","午餐","晚餐","便當","火鍋","麵","飯","外送"]', 1, 0 FROM ledgers;
INSERT INTO ledger_categories (id, ledger_id, name, keywords, sort_order, is_other)
  SELECT lower(hex(randomblob(16))), id, '飲料', '["咖啡","奶茶","飲料","啤酒","手搖","可樂","茶"]', 2, 0 FROM ledgers;
INSERT INTO ledger_categories (id, ledger_id, name, keywords, sort_order, is_other)
  SELECT lower(hex(randomblob(16))), id, '零食甜點', '["零食","甜點","蛋糕","冰淇淋","餅乾","巧克力"]', 3, 0 FROM ledgers;
INSERT INTO ledger_categories (id, ledger_id, name, keywords, sort_order, is_other)
  SELECT lower(hex(randomblob(16))), id, '購物', '["超市","日用品","衣服","鞋子","網購","蝦皮"]', 4, 0 FROM ledgers;
INSERT INTO ledger_categories (id, ledger_id, name, keywords, sort_order, is_other)
  SELECT lower(hex(randomblob(16))), id, '交通', '["捷運","公車","計程車","油錢","停車","高鐵","加油"]', 5, 0 FROM ledgers;
INSERT INTO ledger_categories (id, ledger_id, name, keywords, sort_order, is_other)
  SELECT lower(hex(randomblob(16))), id, '娛樂', '["電影","遊戲","ktv","門票","訂閱","演唱會"]', 6, 0 FROM ledgers;
INSERT INTO ledger_categories (id, ledger_id, name, keywords, sort_order, is_other)
  SELECT lower(hex(randomblob(16))), id, '居家', '["房租","水電","瓦斯","網路","電話","修繕"]', 7, 0 FROM ledgers;
INSERT INTO ledger_categories (id, ledger_id, name, keywords, sort_order, is_other)
  SELECT lower(hex(randomblob(16))), id, '醫療', '["看診","藥","掛號","保健"]', 8, 0 FROM ledgers;
INSERT INTO ledger_categories (id, ledger_id, name, keywords, sort_order, is_other)
  SELECT lower(hex(randomblob(16))), id, '其他', '[]', 99, 1 FROM ledgers;

-- 既有借款：依初始規則補上分類（依序比對，第一個符合的為準；lower 讓英文不分大小寫）
UPDATE loans SET category = CASE
  WHEN instr(lower(item), '早餐') OR instr(item, '午餐') OR instr(item, '晚餐') OR instr(item, '便當')
    OR instr(item, '火鍋') OR instr(item, '麵') OR instr(item, '飯') OR instr(item, '外送') THEN '餐飲'
  WHEN instr(item, '咖啡') OR instr(item, '奶茶') OR instr(item, '飲料') OR instr(item, '啤酒')
    OR instr(item, '手搖') OR instr(item, '可樂') OR instr(item, '茶') THEN '飲料'
  WHEN instr(item, '零食') OR instr(item, '甜點') OR instr(item, '蛋糕') OR instr(item, '冰淇淋')
    OR instr(item, '餅乾') OR instr(item, '巧克力') THEN '零食甜點'
  WHEN instr(item, '超市') OR instr(item, '日用品') OR instr(item, '衣服') OR instr(item, '鞋子')
    OR instr(item, '網購') OR instr(item, '蝦皮') THEN '購物'
  WHEN instr(item, '捷運') OR instr(item, '公車') OR instr(item, '計程車') OR instr(item, '油錢')
    OR instr(item, '停車') OR instr(item, '高鐵') OR instr(item, '加油') THEN '交通'
  WHEN instr(item, '電影') OR instr(item, '遊戲') OR instr(lower(item), 'ktv') OR instr(item, '門票')
    OR instr(item, '訂閱') OR instr(item, '演唱會') THEN '娛樂'
  WHEN instr(item, '房租') OR instr(item, '水電') OR instr(item, '瓦斯') OR instr(item, '網路')
    OR instr(item, '電話') OR instr(item, '修繕') THEN '居家'
  WHEN instr(item, '看診') OR instr(item, '藥') OR instr(item, '掛號') OR instr(item, '保健') THEN '醫療'
  ELSE '其他'
END
WHERE category IS NULL;

-- ── 3. 狀態紀錄加入「補填還款人」set_repayer（建新表 → 搬資料 → 換名字，紀錄全部保留）──
CREATE TABLE loan_events_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id       TEXT NOT NULL,
  ledger_id     TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  actor_id      TEXT NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL CHECK (action IN (
                  'create', 'approve', 'reject', 'resubmit', 'withdraw',
                  'request_repay', 'confirm_repay', 'cancel_repay', 'decline_repay',
                  'set_repayer', 'delete')),
  from_status   TEXT,
  to_status     TEXT,
  note          TEXT,
  snapshot      TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO loan_events_new (id, loan_id, ledger_id, actor_id, action, from_status, to_status, note, snapshot, created_at)
  SELECT id, loan_id, ledger_id, actor_id, action, from_status, to_status, note, snapshot, created_at FROM loan_events;
DROP TABLE loan_events;
ALTER TABLE loan_events_new RENAME TO loan_events;
CREATE INDEX idx_events_loan   ON loan_events(loan_id);
CREATE INDEX idx_events_ledger ON loan_events(ledger_id, created_at);
