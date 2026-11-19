// 共用小工具：回應格式、錯誤、亂數、雜湊、簽章

import { corsHeaders } from './cors.js';

/** 帶有 HTTP 狀態碼與白話訊息的錯誤，會直接回給前端顯示 */
export class HttpError extends Error {
  constructor(status, message, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(request, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request, env) },
  });
}

/** 讀取前端送來的 JSON；格式錯誤時回 400 */
export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, '資料格式不正確', 'bad_json');
  }
}

export const nowIso = () => new Date().toISOString();
export const isoAfter = (ms) => new Date(Date.now() + ms).toISOString();
export const DAY = 24 * 60 * 60 * 1000;

const enc = new TextEncoder();

export function base64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** 產生安全的隨機字串（用於通行證、兌換券） */
export function randomToken(byteLength = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** 產生 UUID 編號 */
export const newId = () => crypto.randomUUID();

/** 產生好念、不易看錯的代碼（去掉 0/O、1/I/L 等容易混淆的字） */
export function readableCode(length) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export async function sha256(text) {
  return base64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** 把資料簽名打包（防止被竄改），用於 Google 登入的 state 參數 */
export async function signPayload(payload, secret) {
  const body = base64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${base64url(sig)}`;
}

/** 驗證簽名並取回資料；被竄改或格式錯誤時回傳 null */
export async function verifyPayload(token, secret) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), base64urlDecode(sig), enc.encode(body));
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(base64urlDecode(body)));
  } catch {
    return null;
  }
}

/** 清理使用者輸入的短文字（去頭尾空白、限制長度） */
export function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}
