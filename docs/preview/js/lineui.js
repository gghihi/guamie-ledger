// LINE 綁定區塊：取得 6 位數綁定碼、查看是否已綁定、解除綁定

import { api } from './api.js';
import { esc, toast, withBusy, confirmDialog } from './ui.js';

export function mountLineBinding(container) {
  async function render(code) {
    let s;
    try {
      s = await api('/api/line/status');
    } catch (err) {
      container.innerHTML = `<section class="card"><h2>💬 LINE</h2><p class="hint">${esc(err.message)}</p></section>`;
      return;
    }
    const addFriend = s.addFriendUrl
      ? `<a class="btn sheep link-btn" href="${esc(s.addFriendUrl)}" target="_blank" rel="noopener">➕ 加 LINE 機器人好友</a>`
      : '';
    let body;
    if (!s.configured) {
      body = '<p class="hint">LINE 機器人還在準備中 🐸</p>';
    } else if (s.bound) {
      body = `
        <p class="ok-text">✅ 你的 LINE 已綁定</p>
        <p class="hint">在 LINE 直接說一句話就能記帳；傳「統整」查看欠款；對方記帳時 LINE 也會通知你。</p>
        ${addFriend}
        <button class="btn ghost" id="line-unbind">解除綁定</button>`;
    } else if (code) {
      body = `
        <p>請在 LINE 傳這句話給機器人（10 分鐘內有效）：</p>
        <div class="invite-code">綁定 ${esc(code)}</div>
        ${addFriend}
        <button class="btn ghost" id="line-copy">複製「綁定 ${esc(code)}」</button>
        <button class="btn ghost" id="line-check">我傳好了，重新檢查</button>`;
    } else {
      body = `
        <p>綁定後可以在 LINE 記帳、同意對方的帳，也會收到 LINE 通知。</p>
        <ol class="steps">
          <li>先加 LINE 機器人好友</li>
          <li>按「取得綁定碼」</li>
          <li>在 LINE 傳「綁定 + 6 位數」</li>
        </ol>
        ${addFriend}
        <button class="btn" id="line-code">取得綁定碼</button>`;
    }
    container.innerHTML = `<section class="card"><h2>💬 LINE</h2>${body}</section>`;

    container.querySelector('#line-code')?.addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        const r = await api('/api/line/bind-code', { method: 'POST' });
        await render(r.code);
      }),
    );
    container.querySelector('#line-copy')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(`綁定 ${code}`);
        toast('已複製，到 LINE 貼上送出吧！', 'ok');
      } catch {
        toast('無法自動複製，請手動輸入', 'error');
      }
    });
    container.querySelector('#line-check')?.addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        await render(code);
        if (!container.querySelector('#line-unbind')) toast('還沒收到綁定，請確認已傳給機器人', 'error');
        else toast('綁定成功 🎉', 'ok');
      }),
    );
    container.querySelector('#line-unbind')?.addEventListener('click', async (e) => {
      const ok = await confirmDialog({ title: '解除 LINE 綁定？', message: '解除後無法在 LINE 記帳，也不會收到 LINE 通知。', okText: '解除綁定' });
      if (!ok) return;
      await withBusy(e.currentTarget, async () => {
        await api('/api/line/binding', { method: 'DELETE' });
        toast('已解除綁定', 'ok');
        await render();
      });
    });
  }
  render();
}
