// Google 登入與通行證（Token）
//
// 登入流程（白話版）：
// 1. 網頁先產生一個只有自己知道的暗號（nonce），把暗號的「指紋」交給後端，再跳到 Google 登入頁。
// 2. Google 登入成功後回到後端；後端用「用戶端密碼」向 Google 確認身分。
// 3. 後端發一張 2 分鐘內有效的一次性兌換券，帶回網頁。
// 4. 網頁拿「兌換券＋原本的暗號」換正式通行證；暗號對不上就拒絕（防止別人把自己的帳號塞給你）。
// 5. 之後網頁每次呼叫後端，都在 Authorization 標頭出示通行證；不使用 Cookie。

import { allowedOrigins } from './cors.js';
import {
  HttpError, json, readJson, nowIso, isoAfter, DAY,
  randomToken, newId, sha256, signPayload, verifyPayload, cleanText,
} from './util.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SESSION_DAYS = 180;          // 通行證有效 180 天，使用中會自動延長
const LOGIN_CODE_MS = 2 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;

function requireAuthConfig(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) {
    throw new HttpError(503, 'Google 登入尚未設定完成', 'auth_not_configured');
  }
}

const callbackUrl = (request) => new URL('/api/auth/google/callback', request.url).toString();

/** 檢查登入完成後要回去的網址，必須是我們自己的網站 */
function safeReturnTo(request, env, value) {
  const fallback = env.FRONTEND_URL;
  if (!value) return fallback;
  try {
    const url = new URL(value);
    return allowedOrigins(env, request).includes(url.origin) ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

/** 第 1 步：跳轉到 Google 登入頁 */
export async function googleStart(request, env) {
  requireAuthConfig(env);
  const params = new URL(request.url).searchParams;
  const nonceHash = cleanText(params.get('nonce_hash'), 100);
  if (nonceHash.length < 20) throw new HttpError(400, '登入請求不完整，請重新整理再試', 'bad_nonce');

  const state = await signPayload(
    { nh: nonceHash, rt: safeReturnTo(request, env, params.get('return_to')), exp: Date.now() + STATE_MS },
    env.SESSION_SECRET,
  );
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(request),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  }).toString();
  return Response.redirect(url.toString(), 302);
}

/** 失敗時帶著錯誤代碼回到網頁 */
function backToApp(returnTo, hashParams) {
  const url = new URL(returnTo);
  url.hash = new URLSearchParams(hashParams).toString();
  return Response.redirect(url.toString(), 302);
}

/** 解讀 Google 回傳的身分資料（直接從 Google 經加密連線取得，可信任） */
function decodeIdToken(idToken) {
  const part = String(idToken || '').split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '==='.slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** 第 2～3 步：Google 登入完成，回到後端 */
export async function googleCallback(request, env) {
  requireAuthConfig(env);
  const params = new URL(request.url).searchParams;
  const state = await verifyPayload(params.get('state'), env.SESSION_SECRET);
  if (!state || state.exp < Date.now()) {
    return backToApp(env.FRONTEND_URL, { login_error: 'expired' });
  }
  if (params.get('error') || !params.get('code')) {
    return backToApp(state.rt, { login_error: 'cancelled' });
  }

  // 用「用戶端密碼」向 Google 換取身分資料
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.get('code'),
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(request),
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    console.error('Google 換取身分失敗', tokenRes.status, await tokenRes.text());
    return backToApp(state.rt, { login_error: 'google_failed' });
  }
  const claims = decodeIdToken((await tokenRes.json()).id_token);
  const issuerOk = claims && ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss);
  if (!issuerOk || claims.aud !== env.GOOGLE_CLIENT_ID || !claims.sub || claims.email_verified === false) {
    return backToApp(state.rt, { login_error: 'google_failed' });
  }

  const userId = await upsertUser(env, claims);
  const loginCode = randomToken(32);
  await env.DB.prepare('INSERT INTO login_codes (code_hash, user_id, nonce_hash, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(loginCode), userId, state.nh, isoAfter(LOGIN_CODE_MS))
    .run();
  return backToApp(state.rt, { login_code: loginCode });
}

/** 新使用者就建立；老使用者就更新名字和頭像 */
async function upsertUser(env, claims) {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE google_sub = ?').bind(claims.sub).first();
  const name = cleanText(claims.name || claims.email?.split('@')[0], 50);
  const avatar = cleanText(claims.picture, 500);
  if (existing) {
    await env.DB.prepare('UPDATE users SET email = ?, display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?')
      .bind(claims.email || '', name, avatar, nowIso(), existing.id)
      .run();
    return existing.id;
  }
  const id = newId();
  await env.DB.prepare('INSERT INTO users (id, google_sub, email, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)')
    .bind(id, claims.sub, claims.email || '', name, avatar)
    .run();
  return id;
}

/** 第 4 步：網頁用「兌換券＋暗號」換正式通行證 */
export async function exchangeLoginCode(request, env) {
  const body = await readJson(request);
  const codeHash = await sha256(cleanText(body.login_code, 200));
  const nonceHash = await sha256(cleanText(body.nonce, 200));

  // 先刪除再檢查：兌換券無論成功與否都只能用一次
  const row = await env.DB.prepare('DELETE FROM login_codes WHERE code_hash = ? RETURNING user_id, nonce_hash, expires_at')
    .bind(codeHash)
    .first();
  if (!row || row.expires_at < nowIso() || row.nonce_hash !== nonceHash) {
    throw new HttpError(401, '登入已逾時或無效，請重新登入', 'bad_login_code');
  }

  const token = randomToken(32);
  await env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(newId(), row.user_id, await sha256(token), cleanText(request.headers.get('User-Agent'), 200), isoAfter(SESSION_DAYS * DAY))
    .run();
  // 順手清掉過期的兌換券
  await env.DB.prepare('DELETE FROM login_codes WHERE expires_at < ?').bind(nowIso()).run();
  return json(request, env, { ok: true, token });
}

/**
 * 驗證通行證，回傳登入中的使用者。每個需要登入的功能都要先呼叫這個。
 * 通行證使用中會自動延長，所以常用的話永遠不用重新登入。
 */
export async function requireUser(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, '請先登入', 'unauthorized');

  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at, s.last_used_at, u.id, u.email, u.display_name, u.avatar_url, u.privacy_ack_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).bind(tokenHash).first();
  if (!row || row.expires_at < nowIso()) throw new HttpError(401, '登入已過期，請重新登入', 'unauthorized');

  // 超過一天沒更新就延長有效期限（避免每次都寫資料庫，節省免費額度）
  if (Date.parse(row.last_used_at) < Date.now() - DAY) {
    await env.DB.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?')
      .bind(nowIso(), isoAfter(SESSION_DAYS * DAY), row.session_id)
      .run();
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    privacyAckAt: row.privacy_ack_at,
  };
}

/** 登出：刪除這支手機的通行證 */
export async function logout(request, env) {
  const user = await requireUser(request, env);
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(user.sessionId).run();
  return json(request, env, { ok: true });
}
