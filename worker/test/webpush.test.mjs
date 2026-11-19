// 網頁推播的自動測試（第 11 階段）
// 模擬「手機」產生鑰匙，讓我們的程式加密訊息，再用手機的角度解密，確認內容一模一樣。
// 執行方式：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { encryptPayload, vapidAuthorization, sendPush, b64urlEncode, b64urlDecode } from '../src/webpush.js';

const subtle = webcrypto.subtle;
const enc = new TextEncoder();

async function hkdf(salt, ikm, info, len) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

/** 模擬一支手機：產生推播鑰匙 */
async function fakePhone() {
  const keys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicRaw = new Uint8Array(await subtle.exportKey('raw', keys.publicKey));
  const auth = webcrypto.getRandomValues(new Uint8Array(16));
  return { keys, publicRaw, auth, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: b64urlEncode(publicRaw), auth: b64urlEncode(auth) } };
}

/** 用手機的角度解密（RFC 8291） */
async function phoneDecrypt(phone, body) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const serverPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const serverKey = await subtle.importKey('raw', serverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: serverKey }, phone.keys.privateKey, 256));
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...phone.publicRaw, ...serverPublic]);
  const ikm = await hkdf(phone.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
  assert.equal(plain[plain.length - 1], 2, '最後一段標記應為 0x02');
  return new TextDecoder().decode(plain.slice(0, -1));
}

async function vapidEnv() {
  const keys = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', keys.privateKey);
  const publicRaw = new Uint8Array(await subtle.exportKey('raw', keys.publicKey));
  return { keys, env: { VAPID_PRIVATE_KEY: JSON.stringify(jwk), VAPID_PUBLIC_KEY: b64urlEncode(publicRaw), FRONTEND_URL: 'https://example.github.io/app/' } };
}

test('加密後，只有那支手機能解開，而且內容完全一樣（含中文）', async () => {
  const phone = await fakePhone();
  const message = JSON.stringify({ title: '呱咩小窩帳', body: '📒 咩咩 記了一筆帳：晚餐 $350，等你確認' });
  const body = await encryptPayload(phone.sub, message);
  assert.equal(await phoneDecrypt(phone, body), message);
});

test('別支手機解不開', async () => {
  const phone = await fakePhone();
  const other = await fakePhone();
  const body = await encryptPayload(phone.sub, 'secret');
  await assert.rejects(() => phoneDecrypt({ ...other, publicRaw: phone.publicRaw, auth: phone.auth }, body));
});

test('VAPID 簽名可以用公鑰驗證，而且對象是推播公司的網域', async () => {
  const { keys, env } = await vapidEnv();
  const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', env);
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, env.VAPID_PUBLIC_KEY);
  const [h, c, sig] = jwt.split('.');
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, b64urlDecode(sig), enc.encode(`${h}.${c}`));
  assert.ok(ok);
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.ok(claims.exp > Date.now() / 1000);
  assert.ok(!String(claims.sub).includes('@'), '聯絡方式不放個人 Email');
});

test('送出推播：帶正確標頭；訂閱失效（410）時回報 gone', async () => {
  const phone = await fakePhone();
  const { env } = await vapidEnv();
  let seen;
  const ok = await sendPush(phone.sub, { title: 't' }, env, async (url, init) => { seen = init; return new Response(null, { status: 201 }); });
  assert.equal(ok, 'ok');
  assert.equal(seen.headers['Content-Encoding'], 'aes128gcm');
  assert.match(seen.headers.Authorization, /^vapid t=/);
  const gone = await sendPush(phone.sub, { title: 't' }, env, async () => new Response(null, { status: 410 }));
  assert.equal(gone, 'gone');
});
