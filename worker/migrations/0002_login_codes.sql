-- 第 4 階段：一次性登入碼
-- 白話：Google 登入完成後，後端先發一張「2 分鐘內有效、只能用一次」的兌換券給網頁，
-- 網頁再拿兌換券換正式通行證。這樣正式通行證永遠不會出現在網址上。
CREATE TABLE login_codes (
  code_hash     TEXT PRIMARY KEY,                 -- 兌換券的雜湊值（不存原文）
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nonce_hash    TEXT NOT NULL,                    -- 綁定「發起登入的那個瀏覽器」，防止別人塞登入
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT NOT NULL
);
