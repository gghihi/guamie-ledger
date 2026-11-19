-- 第 8 階段補充：狀態紀錄加入「取消還款標記」與「還沒收到（退回還款）」兩種動作
-- SQLite 無法直接修改欄位的檢查規則，所以用「建新表 → 搬資料 → 換名字」的方式更新。

CREATE TABLE loan_events_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id       TEXT NOT NULL,
  ledger_id     TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  actor_id      TEXT NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL CHECK (action IN (
                  'create', 'approve', 'reject', 'resubmit', 'withdraw',
                  'request_repay', 'confirm_repay', 'cancel_repay', 'decline_repay', 'delete')),
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
