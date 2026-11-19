// 呱咩小窩帳｜前端主程式
// 第 2 階段：只檢查「網頁能不能連上後端」。

(async function checkBackend() {
  const statusEl = document.getElementById('status');
  const hintEl = document.getElementById('hint');

  try {
    const res = await fetch(`${window.APP_CONFIG.API_BASE}/api/health`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error('後端回應異常');

    statusEl.className = 'status ok';
    statusEl.textContent = '🐑 連線成功！' + data.message;
  } catch (err) {
    statusEl.className = 'status fail';
    statusEl.textContent = '😿 連不上後端';
    hintEl.textContent = '請稍後再試；如果一直失敗，請告訴 Claude。';
    console.error(err);
  }
})();
