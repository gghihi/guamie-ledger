-- 直接記帳（花費紀錄）：不是借款，只記「誰付了多少錢、買什麼、哪一天」
-- 白話：例如「咩咩今天買菜 500」。不用對方確認，會直接算進歷史紀錄的花費（算給付錢的人）。
-- 和借款（loans）分開存，不會出現在借還款的「待確認／未還／已還」，也不算進統整。
CREATE TABLE expenses (
  id            TEXT PRIMARY KEY,
  ledger_id     TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  payer_id      TEXT NOT NULL REFERENCES users(id),     -- 付錢的人（花費算給他）
  amount        INTEGER NOT NULL CHECK (amount > 0 AND amount <= 100000000),
  item          TEXT NOT NULL CHECK (length(trim(item)) > 0 AND length(item) <= 100),
  expense_date  TEXT NOT NULL CHECK (expense_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  category      TEXT,                                   -- 記帳當下依分類規則存下來
  created_by    TEXT NOT NULL REFERENCES users(id),     -- 記這筆的人
  parse_source  TEXT NOT NULL DEFAULT 'manual' CHECK (parse_source IN ('gemini', 'rules', 'manual')),
  input_channel TEXT NOT NULL DEFAULT 'web' CHECK (input_channel IN ('web', 'voice', 'line')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_expenses_ledger_date ON expenses(ledger_id, expense_date);
