# 呱咩小窩帳

兩人共用的借款／還款記帳小工具（PWA 網頁版，可加入手機桌面）。
主題：青蛙「呱呱」與綿羊「咩咩」的溫馨小窩。

完整規劃請見 [計劃文件.md](計劃文件.md)。

## 資料夾說明

| 資料夾 | 用途 |
|---|---|
| `docs/` | 前端網頁，由 GitHub Pages 發布 |
| `worker/` | 後端，部署到 Cloudflare Workers |
| `app 封面/` | 原始圖示檔（記帳APP 圖示.png） |
| `tools/` | 本機測試用的小工具 |

## 本機測試

```bash
npm --prefix worker install
```

```bash
npm --prefix worker run dev
```

```bash
node tools/static-server.mjs
```

然後用瀏覽器開啟 http://localhost:5500 ，看到「連線成功」即代表前後端串接正常。

## 安全提醒

- 所有金鑰（Google、LINE、Gemini、VAPID）一律用 `npx wrangler secret put 名稱` 存進 Cloudflare，**不得寫進程式碼**。
- 本機測試用的 `worker/.dev.vars` 已被 `.gitignore` 排除，不會上傳。
