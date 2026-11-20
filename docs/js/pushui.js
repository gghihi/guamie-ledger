// 通知開關：開啟／關閉網頁推播、傳送測試通知
// iPhone 限制：需要 iOS 16.4 以上，而且必須「加入主畫面」後從桌面圖示打開，才能開啟通知。

import { api } from './api.js';
import { esc, toast, withBusy } from './ui.js';

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** 註冊背景小幫手（每次開 APP 都呼叫，沒有副作用） */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    // 背景小幫手有新版本時：自動換新，並重新載入一次畫面（第一次安裝時不重新載入）
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) {
        reloaded = true;
        location.reload();
      }
    });
    const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    reg.update().catch(() => {});
    return reg;
  } catch (err) {
    console.warn('背景小幫手註冊失敗', err);
    return null;
  }
}

export function mountPushToggle(container) {
  async function currentSubscription() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function render() {
    let html;
    if (isIOS() && !isStandalone()) {
      html = `
        <p>iPhone 要先把小窩<b>加入主畫面</b>，才能收到通知：</p>
        <ol class="steps">
          <li>用 <b>Safari</b> 打開這個網頁。</li>
          <li>按下方的「分享」<span aria-hidden="true">⬆️</span>。</li>
          <li>選「<b>加入主畫面</b>」→「新增」。</li>
          <li>從桌面的「呱咩小窩帳」圖示打開，再回到這裡開啟通知。</li>
        </ol>
        <p class="hint">需要 iOS 16.4 以上（設定 → 一般 → 關於本機 → iOS 版本）。</p>`;
    } else if (!pushSupported()) {
      html = '<p class="hint">這個瀏覽器不支援網頁通知。可以改用 Chrome，或等 LINE 通知（之後的階段）。</p>';
    } else if (Notification.permission === 'denied') {
      html = '<p class="hint">通知被封鎖了。請到瀏覽器或手機的「設定 → 通知」裡，允許「呱咩小窩帳」，再重新整理。</p>';
    } else {
      const sub = await currentSubscription().catch(() => null);
      html = sub
        ? `<p class="ok-text">✅ 這支手機已開啟通知</p>
           <div class="row">
             <button class="btn" id="push-test">傳送測試通知</button>
             <button class="btn ghost" id="push-off">關閉通知</button>
           </div>`
        : `<p>對方記帳、否定、還款時，第一時間通知你。</p>
           <button class="btn" id="push-on">🔔 開啟通知</button>`;
    }
    container.innerHTML = `<section class="card"><h2>🔔 通知</h2>${html}</section>`;
    container.querySelector('#push-on')?.addEventListener('click', (e) => withBusy(e.currentTarget, turnOn));
    container.querySelector('#push-off')?.addEventListener('click', (e) => withBusy(e.currentTarget, turnOff));
    container.querySelector('#push-test')?.addEventListener('click', (e) =>
      withBusy(e.currentTarget, async () => {
        const r = await api('/api/push/test', { method: 'POST' });
        toast(r.ok ? `已送出測試通知（${r.ok}/${r.total} 台裝置）` : '測試通知沒有送達，請關閉後重新開啟通知', r.ok ? 'ok' : 'error');
      }),
    );
  }

  async function turnOn() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('沒有允許通知，之後可以到設定裡開啟', 'error');
      return render();
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(window.APP_CONFIG.VAPID_PUBLIC_KEY),
    });
    await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
    toast('通知開啟了 🐸', 'ok');
    render();
  }

  async function turnOff() {
    const sub = await currentSubscription();
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
    toast('已關閉這支手機的通知', 'ok');
    render();
  }

  render().catch((err) => {
    container.innerHTML = `<section class="card"><h2>🔔 通知</h2><p class="hint">${esc(err.message)}</p></section>`;
  });
}
