// 共用的畫面小工具：安全文字、提示泡泡、確認畫面、處理中按鈕

/** 把文字轉成安全的 HTML（防止別人在暱稱或項目裡塞程式碼） */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

/** 確認畫面：回傳 Promise，按「確認」為 true、按「取消」為 false */
export function confirmDialog({ title, message, okText = '確認', cancelText = '取消' }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal card" role="dialog" aria-modal="true">
        <h2>${esc(title)}</h2>
        <p>${esc(message)}</p>
        <div class="row">
          <button class="btn ghost" data-v="0">${esc(cancelText)}</button>
          <button class="btn" data-v="1">${esc(okText)}</button>
        </div>
      </div>`;
    wrap.addEventListener('click', (e) => {
      const v = e.target.dataset?.v;
      if (v === undefined && e.target !== wrap) return;
      wrap.remove();
      resolve(v === '1');
    });
    document.body.appendChild(wrap);
  });
}

/** 開一個自訂內容的視窗；回傳 { el, close } */
export function openModal(innerHtml) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal card" role="dialog" aria-modal="true">${innerHtml}</div>`;
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });
  document.body.appendChild(wrap);
  return { el: wrap.querySelector('.modal'), close };
}

/** 按鈕送出時先變成「處理中」，避免重複按 */
export async function withBusy(button, task) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '處理中…';
  try {
    await task();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

/** 2026-11-18 → 11/18（週三） */
export function prettyDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const w = '日一二三四五六'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}（${w}）`;
}

export const money = (n) => `$${Number(n).toLocaleString('zh-TW')}`;

/** 台灣時間的今天 YYYY-MM-DD */
export function todayTaipei(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
