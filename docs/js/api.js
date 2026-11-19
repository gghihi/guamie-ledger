// 與後端溝通：保管通行證、送出請求
// 通行證存在這支手機的瀏覽器裡（localStorage），關掉再開仍然有效。

const TOKEN_KEY = 'guamie_token';
const NONCE_KEY = 'guamie_login_nonce';

const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* 無痕模式可能無法儲存 */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* 忽略 */ }
  },
};

export const getToken = () => store.get(TOKEN_KEY);
export const clearToken = () => store.remove(TOKEN_KEY);

/** 後端回應的錯誤，帶有白話訊息 */
export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 呼叫後端；自動附上通行證 */
export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`${window.APP_CONFIG.API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, '連不上網路，請檢查網路後再試', 'network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    if (res.status === 401) clearToken();
    throw new ApiError(res.status, data.error || '發生錯誤，請稍後再試', data.code);
  }
  return data;
}

// ───────── Google 登入 ─────────

function randomString() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 前往 Google 登入：先產生只有這支手機知道的暗號 */
export async function startGoogleLogin() {
  const nonce = randomString();
  store.set(NONCE_KEY, nonce);
  const params = new URLSearchParams({
    nonce_hash: await sha256(nonce),
    return_to: location.origin + location.pathname,
  });
  location.href = `${window.APP_CONFIG.API_BASE}/api/auth/google/start?${params}`;
}

/**
 * 檢查網址是否帶著 Google 登入的結果；有的話換成正式通行證。
 * 回傳：null（沒有登入結果）、'ok'、或錯誤訊息文字
 */
export async function finishGoogleLogin() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const code = hash.get('login_code');
  const error = hash.get('login_error');
  if (!code && !error) return null;

  // 立刻把兌換券從網址上清掉，避免被看到或重複使用
  history.replaceState(null, '', location.pathname + location.search);

  if (error) {
    return error === 'cancelled' ? '已取消登入' : '登入沒有成功，請再試一次';
  }
  const nonce = store.get(NONCE_KEY);
  store.remove(NONCE_KEY);
  if (!nonce) return '登入沒有成功，請在同一個瀏覽器重新登入';

  try {
    const data = await api('/api/auth/exchange', { method: 'POST', body: { login_code: code, nonce } });
    store.set(TOKEN_KEY, data.token);
    return 'ok';
  } catch (err) {
    return err.message;
  }
}

export async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } finally {
    clearToken();
  }
}
