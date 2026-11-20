# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

呱咩小窩帳：兩人共用的借款／還款記帳 PWA。完整規格與決策在 `計劃文件.md`，給使用者的白話說明在 `使用與維護說明.md`。

## 與使用者合作的規則

- 使用者沒有程式背景：所有說明、程式註解、介面文字一律**繁體中文**、白話，術語第一次出現要解釋。
- 能自己做的就自己做；只有帳號申請、授權、同意條款、付款這類事情才請使用者動手，並給編號步驟。任何需要付費的事先停下來說明。
- 一次最多問 3 個問題，並提供選項與建議。需求不清楚或有衝突時先問。
- 程式庫**維持公開**（免費 GitHub Pages 需要公開）。使用者已兩次確認，不要改成私人。

## 常用指令（在 `worker/` 內執行）

```bash
npm test                                   # 單元測試（node:test，含 node:sqlite 模擬 D1）
node --test test/parse.test.mjs            # 只跑單一測試檔
node --test --test-name-pattern="金額" test/   # 只跑名稱符合的測試
npm run dev                                # 本機後端 http://localhost:8787（讀 worker/.dev.vars）
npm run seed:local && npm run check:local  # 重設本機資料 → 跑整合測試（需先 npm run dev）
npx wrangler deploy                        # 部署主要後端
npx wrangler deploy --config ../worker-gemini/wrangler.toml   # 部署 Gemini 轉送站
npx wrangler d1 migrations apply guamie-ledger-db --local     # 套用遷移（再用 --remote 套用雲端）
```

- 前端本機預覽：在專案根目錄跑 `node tools/static-server.mjs`（http://localhost:5500，`config.js` 會自動改連本機後端）。`.claude/launch.json` 有 `frontend`、`worker` 兩個設定可直接用。
- 前端沒有建置步驟，推到 `main` 後 GitHub Pages 會自動發布 `docs/`。
- 沒有 lint 工具；改前端後至少跑 `node --check docs/js/<檔案>.js`。
- 健康檢查：`/api/health`；加上 `?gemini=1` 會確認經轉送站到 Gemini 的路線。

## 架構

```
docs/（GitHub Pages）──Bearer token──► worker/（Cloudflare Worker，亞洲）──► D1 guamie-ledger-db
                                             │  ├─► Web Push（自行實作 VAPID，不用 Firebase）
                                             │  └─► LINE Messaging API ◄── LINE Webhook
                                             └─(service binding GEMINI_PROXY)─► worker-gemini/（美國）─► Gemini API
```

- **Gemini 轉送站**：Google 不開放 Cloudflare 香港機房（台灣常被分到這裡）使用 Gemini API，所以 `worker-gemini` 設了 `placement = gcp:us-central1`、沒有公開網址。`GEMINI_API_KEY` **只存在轉送站**。`parse/gemini.js` 的 `geminiTransport()` 有綁定時走轉送站，沒有綁定（本機）時直接連 Google。
- **解析流程**（`worker/src/parse/index.js` 的 `analyze`）：先試 `GEMINI_MODEL`，失敗再試 `GEMINI_FALLBACK_MODEL`，兩個都失敗才用 `rules.js` 規則解析，並回傳 `notice: '目前使用備用解析'`。語音只有 Gemini 聽得懂，失敗時請使用者改打字。看不懂的欄位一律留 null 交給追問，不要猜。模型名稱只放在 `wrangler.toml` 的 vars。
- **網頁和 LINE 共用核心邏輯**：`createLoanCore`、`approveCore`、`rejectCore`、`computeSummary` 給 HTTP handler 和 `line.js` 共用。新增狀態操作時，兩邊都要考慮。
- **權限模型**：每個 handler 先 `requireUser`（Bearer token → `sessions.token_hash`），再 `loadLedgerContext` / `requireMyLedger`（一人只屬於一本帳、每本帳最多 2 人，有 DB trigger 保護）。所有讀寫 `loans` 的 SQL 都要帶 `ledger_id = ?`。狀態變更一律用條件式 UPDATE（`WHERE status = ? AND ...`），再檢查 `meta.changes`，避免兩人同時操作出錯，並寫一筆 `loan_events`。
- **借款狀態**：`pending → unpaid → repay_pending → paid`，另有 `rejected`。`repay_pending` 可以 `cancel-repay`（標記的人）或 `decline-repay`（對方）退回 `unpaid`。統整只算 `unpaid` 和 `repay_pending`。撤回或刪除會真的刪掉那筆，歷史留在 `loan_events`。
- **通知**：`notify.js` 透過 `env.waitUntil` 在背景同時送 Web Push 和 LINE。LINE 主動通知有每月上限（`line_push_usage`、`LINE_MONTHLY_PUSH_LIMIT`），回覆訊息不受限。
- **Google 登入**：Worker 端用 authorization code 流程，前端產生 nonce 防止別人塞登入；callback 發一次性 `login_codes`，前端再換成 session token 存 localStorage。全程不用 Cookie。
- **離開小窩**：需先結清；離開者的暱稱存進 `ledger_former_members`，讓查詢顯示名字時可以 COALESCE；最後一人離開時刪除整本帳（cascade）。

## 容易踩的坑

- `index.js` 的 `fetch` 會包一層 env 加上 `waitUntil`，**必須用展開** `{ ...rawEnv, waitUntil }`。用 `Object.create(rawEnv)` 的話，之後的 `{...env}` 會弄丟設定（曾造成 `no_model`，Gemini 一直失敗）。
- 放密碼到 Wrangler secrets 時，**不要**從 Windows PowerShell 5.1 直接 pipe 給 `npx`，它會在開頭加 UTF-8 BOM。用 PowerShell 讀剪貼簿放進環境變數，再交給 Node 的 `spawnSync` 當 stdin。`cleanApiKey()` 會再清一次，但不要依賴它。使用者**不希望金鑰存成檔案**，也不要把真正的金鑰寫進 `worker/.dev.vars`（本機只放假值）。
- 改前端後要把 `docs/sw.js` 的 `VERSION` 加一。Service worker 會對 script、style、頁面用 `cache: 'no-cache'` 重新驗證（GitHub Pages 的 `max-age=600` 曾讓手機看到舊畫面）。
- 同時改多個後端檔案時，先停掉本機 `wrangler dev`，因為它在改到一半時熱重載會當掉。
- 新增遷移檔後，`test/schema.test.mjs` 會依序套用 `migrations/` 全部檔案，有新表格時要更新它預期的表格清單；`test/seed-local.sql` 開頭的 DELETE 也要補上新表格。
- `wrangler tail` 的錯誤訊息可能印出請求標頭裡的金鑰：監看時要遮罩，用完刪掉暫存檔。
