-- 離開小窩功能：記住「已離開成員」在這本帳裡的暱稱
-- 白話：有人離開後，留下的人看歷史帳目時，仍然看得到「呱呱 欠 咩咩」而不是一片空白。
CREATE TABLE ledger_former_members (
  ledger_id     TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  nickname      TEXT NOT NULL DEFAULT '',
  left_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ledger_id, user_id)
);
