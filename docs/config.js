// 呱咩小窩帳｜前端公開設定
// 這個檔案會公開在網路上，所以「只能放公開資訊」，絕對不放任何密碼或金鑰。

window.APP_CONFIG = {
  // 後端網址：在本機測試時自動使用本機後端，正式網站使用 Cloudflare 上的後端。
  API_BASE:
    location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      ? 'http://localhost:8787'
      : 'https://guamie-ledger-api.guamie-ledger-api.workers.dev',
};
