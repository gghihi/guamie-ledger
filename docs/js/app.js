// 呱咩小窩帳｜前端主程式（第 4 階段：登入、建立／加入小窩、邀請碼）

import { api, getToken, startGoogleLogin, finishGoogleLogin, logout } from './api.js';

const app = document.getElementById('app');
let state = { me: null };

// ───────── 小工具 ─────────

/** 把文字轉成安全的 HTML（防止別人在暱稱裡塞程式碼） */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(message, type = 'info') {
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
function confirmDialog({ title, message, okText = '確認', cancelText = '取消' }) {
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

/** 按鈕送出時先變成「處理中」，避免重複按 */
async function withBusy(button, task) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '處理中…';
  try {
    await task();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

const formatDate = (iso) =>
  new Date(iso).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'long', day: 'numeric' });

// ───────── 畫面 ─────────

function renderLoading(text = '小青蛙正在開門…') {
  app.innerHTML = `<section class="card center"><div class="bounce">🐸</div><p>${esc(text)}</p></section>`;
}

function renderLogin() {
  app.innerHTML = `
    <section class="card center">
      <img class="logo" src="icons/記帳APP 圖示.png" alt="呱咩小窩帳圖示" />
      <h1>呱咩小窩帳</h1>
      <p class="subtitle">呱呱與咩咩的借還款小帳本</p>
      <button class="btn google" id="login">
        <span class="g">G</span> 用 Google 帳號登入
      </button>
      <p class="hint">登入後會一直保持登入，不用每次重登。</p>
    </section>`;
  document.getElementById('login').onclick = (e) => withBusy(e.currentTarget, startGoogleLogin);
}

function renderSetup() {
  const name = state.me.user.displayName;
  app.innerHTML = `
    ${userBar()}
    <section class="card">
      <h2>🏠 建立新的小窩</h2>
      <p class="hint">由第一個人建立，建好後會得到邀請碼給另一半。</p>
      <label>你在小窩裡的暱稱<input id="c-nick" maxlength="12" placeholder="例如：呱呱" value="${esc(name)}" /></label>
      <button class="btn" id="create">建立小窩</button>
    </section>
    <div class="or">或</div>
    <section class="card">
      <h2>🔑 用邀請碼加入</h2>
      <p class="hint">另一半已經建好小窩了？輸入他給你的邀請碼。</p>
      <label>邀請碼<input id="j-code" maxlength="9" placeholder="例如：ABCD-2345" autocapitalize="characters" autocomplete="off" /></label>
      <label>你在小窩裡的暱稱<input id="j-nick" maxlength="12" placeholder="例如：咩咩" value="${esc(name)}" /></label>
      <button class="btn sheep" id="join">加入小窩</button>
    </section>`;
  bindUserBar();

  document.getElementById('create').onclick = (e) =>
    withBusy(e.currentTarget, async () => {
      const nickname = document.getElementById('c-nick').value.trim();
      if (!nickname) return toast('請先填暱稱喔', 'error');
      await api('/api/ledgers', { method: 'POST', body: { nickname } });
      toast('小窩建好了！把邀請碼傳給另一半吧 🐑', 'ok');
      await refresh();
    });

  document.getElementById('join').onclick = (e) =>
    withBusy(e.currentTarget, async () => {
      const code = document.getElementById('j-code').value.trim();
      const nickname = document.getElementById('j-nick').value.trim();
      if (!code) return toast('請輸入邀請碼', 'error');
      if (!nickname) return toast('請先填暱稱喔', 'error');
      const ok = await confirmDialog({
        title: '確定要加入嗎？',
        message: `邀請碼：${code.toUpperCase()}\n加入後，你們兩人會共用同一本帳。`,
        okText: '確定加入',
      });
      if (!ok) return;
      await api('/api/ledgers/join', { method: 'POST', body: { code, nickname } });
      toast('歡迎回家！🐸🐑', 'ok');
      await refresh();
    });
}

function renderHome() {
  const { ledger } = state.me;
  const members = ledger.members
    .map(
      (m) => `
      <li class="member">
        ${m.avatarUrl ? `<img src="${esc(m.avatarUrl)}" alt="" referrerpolicy="no-referrer" />` : '<span class="avatar">🐾</span>'}
        <div>
          <strong>${esc(m.nickname)}</strong>${m.isMe ? ' <span class="tag">我</span>' : ''}
          <small>${esc(m.displayName)}</small>
        </div>
        ${m.isMe ? '<button class="btn tiny ghost" id="edit-nick">改暱稱</button>' : ''}
      </li>`,
    )
    .join('');

  const inviteBlock =
    ledger.members.length < 2
      ? `
    <section class="card">
      <h2>💌 邀請另一半</h2>
      ${
        ledger.invite
          ? `<div class="invite-code" id="invite-code">${esc(ledger.invite.code)}</div>
             <p class="hint">有效到 ${esc(formatDate(ledger.invite.expiresAt))}，只能使用一次。</p>
             <div class="row">
               <button class="btn" id="copy-invite">複製邀請碼</button>
               <button class="btn ghost" id="new-invite">重新產生</button>
             </div>`
          : `<p class="hint">邀請碼已過期。</p><button class="btn" id="new-invite">產生新的邀請碼</button>`
      }
    </section>`
      : '';

  app.innerHTML = `
    ${userBar()}
    <section class="card">
      <h2>🏡 ${esc(ledger.name)}</h2>
      <ul class="members">${members}</ul>
      ${ledger.members.length < 2 ? '<p class="hint">還在等另一半加入…</p>' : '<p class="hint ok-text">兩個人都到齊了！</p>'}
    </section>
    ${inviteBlock}
    <section class="card center soon">
      <p>📒 記帳功能施工中，下一階段就會出現喔！</p>
    </section>`;
  bindUserBar();

  document.getElementById('edit-nick')?.addEventListener('click', async (e) => {
    const me = ledger.members.find((m) => m.isMe);
    const nickname = prompt('新的暱稱（最多 12 個字）', me.nickname);
    if (nickname === null) return;
    await withBusy(e.currentTarget, async () => {
      await api('/api/me/nickname', { method: 'PATCH', body: { nickname } });
      toast('暱稱改好了', 'ok');
      await refresh();
    });
  });

  document.getElementById('copy-invite')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(ledger.invite.code);
      toast('已複製邀請碼，貼給另一半吧！', 'ok');
    } catch {
      toast('無法自動複製，請長按邀請碼手動複製', 'error');
    }
  });

  document.getElementById('new-invite')?.addEventListener('click', async (e) => {
    const ok = await confirmDialog({
      title: '重新產生邀請碼？',
      message: '舊的邀請碼會立刻失效。',
      okText: '重新產生',
    });
    if (!ok) return;
    await withBusy(e.currentTarget, async () => {
      await api('/api/ledgers/invite', { method: 'POST' });
      toast('新的邀請碼來了', 'ok');
      await refresh();
    });
  });
}

function userBar() {
  const u = state.me.user;
  return `
    <header class="userbar">
      ${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="" referrerpolicy="no-referrer" />` : ''}
      <span>${esc(u.displayName)}</span>
      <button class="btn tiny ghost" id="logout">登出</button>
    </header>`;
}

function bindUserBar() {
  document.getElementById('logout').onclick = async (e) => {
    const ok = await confirmDialog({ title: '要登出嗎？', message: '登出後需要重新用 Google 登入。', okText: '登出' });
    if (!ok) return;
    await withBusy(e.currentTarget, async () => {
      await logout().catch(() => {});
      state.me = null;
      renderLogin();
    });
  };
}

/** 第一次使用：Gemini 免費方案隱私提醒 */
function showPrivacyNotice() {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal card" role="dialog" aria-modal="true">
      <h2>🐑 使用前的小提醒</h2>
      <p>記帳時輸入的文字或語音，會交給 Google 的 AI（Gemini）幫忙理解。</p>
      <p>我們使用的是<strong>免費方案</strong>，Google 可能會用這些內容來改進他們的產品。</p>
      <p class="warn-text">請不要輸入身分證字號、銀行帳號、密碼等敏感資料。</p>
      <button class="btn" id="ack">我知道了</button>
    </div>`;
  document.body.appendChild(wrap);
  document.getElementById('ack').onclick = async (e) => {
    await withBusy(e.currentTarget, async () => {
      await api('/api/me/privacy-ack', { method: 'POST' });
      state.me.user.privacyAcknowledged = true;
      wrap.remove();
    });
  };
}

// ───────── 啟動流程 ─────────

async function refresh() {
  state.me = await api('/api/me');
  if (state.me.ledger) renderHome();
  else renderSetup();
  if (!state.me.user.privacyAcknowledged && !document.getElementById('ack')) showPrivacyNotice();
}

async function start() {
  renderLoading();
  const loginResult = await finishGoogleLogin();
  if (loginResult && loginResult !== 'ok') toast(loginResult, 'error');

  if (!getToken()) return renderLogin();
  try {
    await refresh();
  } catch (err) {
    if (err.status === 401) return renderLogin();
    app.innerHTML = `<section class="card center"><p>😿 ${esc(err.message)}</p><button class="btn" id="retry">再試一次</button></section>`;
    document.getElementById('retry').onclick = start;
  }
}

start();
