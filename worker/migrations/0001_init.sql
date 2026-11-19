-- 呱咩小窩帳｜資料庫第一版（第 3 階段）
-- 白話說明：這個檔案定義資料庫裡有哪些「表格」，以及每個表格有哪些欄位與規則。
-- 時間一律用國際標準時間（UTC）存成文字，例如 2026-11-19T12:00:00.000Z。
-- 借款日期用「台灣日期」存成文字，例如 2026-11-19。
-- 金額一律用「新台幣整數元」存。

-- ─────────────────────────────────────────────
-- 1. 使用者：每個 Google 帳號一筆
-- ─────────────────────────────────────────────
CREATE TABLE users (
  id            TEXT PRIMARY KEY,                 -- 我們自己產生的使用者編號
  google_sub    TEXT NOT NULL UNIQUE,             -- Google 帳號的唯一代號
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT NOT NULL DEFAULT '',
  privacy_ack_at TEXT,                            -- 看過「勿輸入敏感資料」提醒的時間
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ─────────────────────────────────────────────
-- 2. 登入通行證：只存「雜湊值」，就算資料外洩也無法拿來登入
-- ─────────────────────────────────────────────
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  user_agent    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ─────────────────────────────────────────────
-- 3. 帳本（小窩）
-- ─────────────────────────────────────────────
CREATE TABLE ledgers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '呱咩小窩',
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ─────────────────────────────────────────────
-- 4. 帳本成員：第一版每本帳最多 2 人
-- ─────────────────────────────────────────────
CREATE TABLE ledger_members (
  ledger_id     TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  nickname      TEXT NOT NULL DEFAULT '',         -- 在這本帳裡的暱稱，例如「呱呱」「咩咩」（語意解析會用到）
  joined_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ledger_id, user_id)
);
CREATE INDEX idx_members_user ON ledger_members(user_id);

-- 資料庫層級的保險：同一本帳超過 2 人時直接拒絕
CREATE TRIGGER trg_ledger_members_max_two
BEFORE INSERT ON ledger_members
WHEN (SELECT COUNT(*) FROM ledger_members WHERE ledger_id = NEW.ledger_id) >= 2
BEGIN
  SELECT RAISE(ABORT, 'ledger_full');
END;

-- ─────────────────────────────────────────────
-- 5. 邀請碼
-- ─────────────────────────────────────────────
CREATE TABLE invite_codes (
  code          TEXT PRIMARY KEY,                 -- 例如 FROG-7K3Q
  ledger_id     TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT NOT NULL,
  used_by       TEXT REFERENCES users(id),
  used_at       TEXT
);
CREATE INDEX idx_invites_ledger ON invite_codes(ledger_id);

-- ─────────────────────────────────────────────
-- 6. 借款紀錄
--    狀態：pending 待確認 → unpaid 未還 → repay_pending 已還待確認 → paid 已還
--          rejected 被否定（可修改重送回 pending，或刪除）
-- ─────────────────────────────────────────────
CREATE TABLE loans (
  id                  TEXT PRIMARY KEY,
  ledger_id           TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  lender_id           TEXT NOT NULL REFERENCES users(id),   -- 借出錢的人（被欠的人）
  borrower_id         TEXT NOT NULL REFERENCES users(id),   -- 欠錢的人
  amount              INTEGER NOT NULL CHECK (amount > 0 AND amount <= 100000000),
  item                TEXT NOT NULL CHECK (length(trim(item)) > 0 AND length(item) <= 100),
  loan_date           TEXT NOT NULL CHECK (loan_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'unpaid', 'repay_pending', 'paid', 'rejected')),
  created_by          TEXT NOT NULL REFERENCES users(id),   -- 記這筆帳的人
  reject_reason       TEXT,
  repay_requested_by  TEXT REFERENCES users(id),            -- 誰按了「已還款」
  parse_source        TEXT NOT NULL DEFAULT 'manual'
                      CHECK (parse_source IN ('gemini', 'rules', 'manual')),
  input_channel       TEXT NOT NULL DEFAULT 'web'
                      CHECK (input_channel IN ('web', 'voice', 'line')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  approved_at         TEXT,
  paid_at             TEXT,
  CHECK (lender_id <> borrower_id)
);
CREATE INDEX idx_loans_ledger_status ON loans(ledger_id, status);
CREATE INDEX idx_loans_ledger_date   ON loans(ledger_id, loan_date);

-- ─────────────────────────────────────────────
-- 7. 狀態變更紀錄（每一次建立、同意、否定、撤回、還款、刪除都留一行）
--    借款紀錄被刪除後，這裡仍保留歷史，所以不設外鍵連到 loans。
-- ─────────────────────────────────────────────
CREATE TABLE loan_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id       TEXT NOT NULL,
  ledger_id     TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  actor_id      TEXT NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL CHECK (action IN (
                  'create', 'approve', 'reject', 'resubmit', 'withdraw',
                  'request_repay', 'confirm_repay', 'delete')),
  from_status   TEXT,
  to_status     TEXT,
  note          TEXT,
  snapshot      TEXT,                             -- 當下內容的 JSON 備份（金額、項目等）
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_events_loan   ON loan_events(loan_id);
CREATE INDEX idx_events_ledger ON loan_events(ledger_id, created_at);

-- ─────────────────────────────────────────────
-- 8. 網頁推播訂閱（每支手機／瀏覽器一筆）
-- ─────────────────────────────────────────────
CREATE TABLE push_subscriptions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint         TEXT NOT NULL UNIQUE,
  p256dh           TEXT NOT NULL,
  auth             TEXT NOT NULL,
  user_agent       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_success_at  TEXT
);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);

-- ─────────────────────────────────────────────
-- 9. LINE 綁定：一個 LINE 帳號對應一個使用者
-- ─────────────────────────────────────────────
CREATE TABLE line_bindings (
  line_user_id  TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 10. LINE 綁定碼（6 位數，短時間有效）
CREATE TABLE line_bind_codes (
  code          TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT NOT NULL
);

-- 11. LINE 草稿：LINE 上還沒確認送出的解析結果與追問進度
CREATE TABLE line_drafts (
  line_user_id  TEXT PRIMARY KEY REFERENCES line_bindings(line_user_id) ON DELETE CASCADE,
  ledger_id     TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  draft_json    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 12. LINE 每月主動推送則數（避免超過免費額度；超過就停發 LINE 通知）
CREATE TABLE line_push_usage (
  month         TEXT PRIMARY KEY,                 -- 例如 2026-11（台灣時間）
  sent_count    INTEGER NOT NULL DEFAULT 0
);
