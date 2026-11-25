// 呱咩小窩帳｜前端主程式
// 第 4 階段：登入、建立／加入小窩、邀請碼
// 第 5 階段：對話式記帳、借款清單

import { api, getToken, startGoogleLogin, finishGoogleLogin, logout } from './api.js';
import { esc, toast, confirmDialog, withBusy, openModal } from './ui.js';
import { mountRecorder } from './record.js';
import { mountLoanList } from './loanlist.js';
import { mountSummary } from './summary.js';
import { mountCalculator } from './calculator.js';
import { mountHistory } from './history.js';
import { registerServiceWorker, mountPushToggle } from './pushui.js';
import { mountLineBinding } from './lineui.js';

const app = document.getElementById('app');
let state = { me: null, list: null, memberKey: '', view: 'home' };

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
  // 建立與加入放在同一張卡片，用上方按鈕切換
  app.innerHTML = `
    ${userBar()}
    <section class="card">
      <div class="seg setup-switch" role="tablist">
        <button type="button" role="tab" data-mode="create" class="on">🏠 建立小窩</button>
        <button type="button" role="tab" data-mode="join">🔑 加入小窩</button>
      </div>
      <div data-panel="create">
        <p class="hint">由第一個人建立，建好後會得到邀請碼給另一半。</p>
        <label>你在小窩裡的暱稱<input id="c-nick" maxlength="12" placeholder="例如：呱呱" value="${esc(name)}" /></label>
        <button class="btn" id="create">建立小窩</button>
      </div>
      <div data-panel="join" hidden>
        <p class="hint">另一半已經建好小窩了？輸入他給你的邀請碼。</p>
        <label>邀請碼<input id="j-code" maxlength="9" placeholder="例如：ABCD-2345" autocapitalize="characters" autocomplete="off" /></label>
        <label>你在小窩裡的暱稱<input id="j-nick" maxlength="12" placeholder="例如：咩咩" value="${esc(name)}" /></label>
        <button class="btn sheep" id="join">加入小窩</button>
      </div>
    </section>`;
  bindUserBar();

  app.querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = () => {
      app.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      app.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.mode; });
    };
  });

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
  const together = ledger.members.length === 2;
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

  const inviteBlock = together
    ? ''
    : `
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
    </section>
    <section class="card center soon"><p>📒 另一半加入後，就可以開始記帳囉！</p></section>`;
  // 只剩自己時（例如另一半離開了），仍可查看以前的帳目

  app.innerHTML = `
    ${userBar()}
    <nav class="seg main-tabs" role="tablist">
      <button type="button" role="tab" data-view="home" class="${state.view === 'history' ? '' : 'on'}">🏠 小窩</button>
      <button type="button" role="tab" data-view="history" class="${state.view === 'history' ? 'on' : ''}">📊 歷史</button>
    </nav>
    <div id="home-view" ${state.view === 'history' ? 'hidden' : ''}>
      <details class="card nest-info" ${together ? '' : 'open'}>
        <summary><h2>🏡 ${esc(ledger.name)}</h2><span class="hint">${together ? '兩個人都到齊了' : '等另一半加入中…'}</span></summary>
        <ul class="members">${members}</ul>
        <button class="btn ghost danger leave-btn" id="leave-nest">🚪 離開小窩</button>
      </details>
      ${inviteBlock}
      <div id="summary"></div>
      <div id="calculator"></div>
      <div id="recorder"></div>
      <div id="loan-list"></div>
    </div>
    <div id="history-view" ${state.view === 'history' ? '' : 'hidden'}></div>
`;
  bindUserBar();

  // 「🏠 小窩／📊 歷史」切換；歷史頁每次切過去都重新抓資料
  const histView = mountHistory(document.getElementById('history-view'));
  const showView = (view) => {
    state.view = view;
    app.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    document.getElementById('home-view').hidden = view !== 'home';
    document.getElementById('history-view').hidden = view !== 'history';
    if (view === 'history') histView.refresh();
    window.scrollTo({ top: 0 });
  };
  app.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => showView(b.dataset.view);
  });
  if (state.view === 'history') histView.refresh();

  if (together) {
    const me = ledger.members.find((m) => m.isMe);
    const partner = ledger.members.find((m) => !m.isMe);
    const summary = mountSummary(document.getElementById('summary'));
    const list = mountLoanList(document.getElementById('loan-list'), { partner, onChange: () => summary.refresh() });
    state.list = list;
    const recorder = mountRecorder(document.getElementById('recorder'), { me, partner, onSaved: () => list.refresh() });
    mountCalculator(document.getElementById('calculator'), { onUse: (amount) => recorder.setAmount(amount) });
  } else {
    state.list = mountLoanList(document.getElementById('loan-list'), { partner: { nickname: '對方' } });
  }

  document.getElementById('leave-nest').addEventListener('click', (e) => leaveNest(e.currentTarget, together));

  document.getElementById('edit-nick')?.addEventListener('click', async (e) => {
    e.preventDefault();
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

/** 離開小窩：先檢查有沒有沒結清的帳，再依情況顯示不同的確認畫面 */
async function leaveNest(button, together) {
  const STATUS = { pending: '待確認', unpaid: '未還', repay_pending: '已還待確認' };
  let open = [];
  try {
    open = (await api('/api/loans')).loans.filter((l) => STATUS[l.status]);
  } catch (err) {
    return toast(err.message, 'error');
  }
  if (open.length) {
    const list = open.slice(0, 8).map((l) => `・${l.item} $${l.amount}（${STATUS[l.status]}）`).join('\n');
    await confirmDialog({
      title: '還有帳沒有結清喔',
      message: [
        `要先處理完這 ${open.length} 筆，才能離開小窩：`,
        '',
        list + (open.length > 8 ? '\n…' : ''),
        '',
        '待確認的請對方同意或否定（或自己撤回）；未還的請完成還款確認。',
      ].join('\n'),
      okText: '我知道了',
      cancelText: '關閉',
    });
    return;
  }
  const ok = await confirmDialog(together
    ? {
        title: '確定要離開小窩嗎？',
        message: [
          '離開後：',
          '・你將看不到這本帳',
          '・帳目會留給另一半，他之後可以邀請別人加入',
          '・另一半會收到通知',
          '',
          '離開後可以建立或加入新的小窩。',
        ].join('\n'),
        okText: '確定離開',
      }
    : {
        title: '⚠️ 你是最後一個人',
        message: '離開後，這本小窩和裡面所有的帳目會被「永久刪除」，無法復原。\n\n確定要離開嗎？',
        okText: '永久刪除並離開',
      });
  if (!ok) return;
  await withBusy(button, async () => {
    const r = await api('/api/ledgers/leave', { method: 'POST' });
    toast(r.deleted ? '小窩已刪除' : '已離開小窩', 'ok');
    await refresh();
  });
}

function userBar() {
  const u = state.me.user;
  return `
    <header class="userbar">
      ${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="" referrerpolicy="no-referrer" />` : ''}
      <span>${esc(u.displayName)}</span>
      <button class="btn tiny ghost" id="open-settings" aria-label="設定">⚙️ 設定</button>
      <button class="btn tiny ghost" id="logout">登出</button>
    </header>`;
}

/** ⚙️ 設定：通知與 LINE 綁定 */
function openSettings() {
  const { el } = openModal(`
    <div class="settings-head">
      <h2>⚙️ 設定</h2>
      <button class="btn tiny ghost" data-close aria-label="關閉設定">✕ 關閉</button>
    </div>
    <div id="settings-push"></div>
    <div id="settings-line"></div>`);
  el.classList.add('settings');
  mountPushToggle(el.querySelector('#settings-push'));
  mountLineBinding(el.querySelector('#settings-line'));
}

function bindUserBar() {
  document.getElementById('open-settings').onclick = openSettings;
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
  registerServiceWorker();
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

// ───────── 同步更新 ─────────
// 只更新清單與統整（不重畫整頁，正在打的記帳草稿不會不見）；
// 小窩成員有變動（對方加入或離開）時才重畫整頁。
const memberKey = (me) => (me?.ledger ? me.ledger.members.map((m) => m.userId + m.nickname).join('|') : '');
let syncing = false;
async function syncNow() {
  if (syncing || !state.me?.ledger || document.visibilityState !== 'visible') return;
  syncing = true;
  try {
    const me = await api('/api/me');
    if (memberKey(me) !== memberKey(state.me)) {
      await refresh();
    } else {
      await state.list?.refresh({ quiet: true });
    }
  } catch {
    /* 背景同步失敗就等下一次 */
  } finally {
    syncing = false;
  }
}

// 1. 收到推播時（APP 正開著）立刻更新
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'refresh') syncNow();
});
// 2. 切回 APP 時更新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncNow();
});
// 3. APP 開在畫面上時，每 20 秒檢查一次（沒開通知的人也能同步）
setInterval(syncNow, 20000);
