// 推播訂閱管理：開啟通知、關閉通知、傳送測試通知

import { requireUser } from './auth.js';
import { sendPush, b64urlDecode } from './webpush.js';
import { HttpError, json, readJson, newId, nowIso, cleanText } from './util.js';

const ALLOWED_PUSH_HOSTS = [
  /\.googleapis\.com$/,        // Chrome、Android
  /\.mozilla\.com$/,           // Firefox
  /\.push\.apple\.com$/,       // iPhone、Mac Safari
  /\.notify\.windows\.com$/,   // Edge（Windows）
];

/** 只接受各大瀏覽器正式推播服務的地址，避免被拿去亂打別的網站 */
function validEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && ALLOWED_PUSH_HOSTS.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}

/** POST /api/push/subscribe：這支手機開啟通知 */
export async function subscribePush(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const endpoint = String(body.endpoint || '');
  const p256dh = String(body.keys?.p256dh || '');
  const auth = String(body.keys?.auth || '');
  if (!validEndpoint(endpoint)) throw new HttpError(400, '這個瀏覽器的推播地址不正確', 'bad_endpoint');
  try {
    if (b64urlDecode(p256dh).length !== 65 || b64urlDecode(auth).length < 16) throw new Error();
  } catch {
    throw new HttpError(400, '推播鑰匙格式不正確', 'bad_keys');
  }
  // 同一個推播地址只留一筆（換人登入同一支手機時，改成新的使用者）
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
  ).bind(newId(), user.id, endpoint, p256dh, auth, cleanText(request.headers.get('User-Agent'), 200)).run();
  return json(request, env, { ok: true });
}

/** POST /api/push/unsubscribe：這支手機關閉通知 */
export async function unsubscribePush(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(String(body.endpoint || ''), user.id).run();
  return json(request, env, { ok: true });
}

/** POST /api/push/test：傳一則測試通知給自己所有已開啟通知的裝置 */
export async function testPush(request, env) {
  const user = await requireUser(request, env);
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) throw new HttpError(503, '推播尚未設定完成', 'push_not_configured');
  const sent = await pushToUser(env, user.id, {
    title: '呱咩小窩帳',
    body: '🐸🐑 這是一則測試通知，看到就代表通知開啟成功囉！',
    url: env.FRONTEND_URL,
    tag: 'test',
  });
  if (!sent.total) throw new HttpError(404, '這個帳號還沒有任何裝置開啟通知', 'no_subscription');
  return json(request, env, { ok: true, ...sent });
}

/** 推播給某個使用者的所有裝置；失效的訂閱自動刪除 */
export async function pushToUser(env, userId, message, fetchImpl) {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return { total: 0, ok: 0 };
  const { results } = await env.DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').bind(userId).all();
  let ok = 0;
  for (const sub of results) {
    const r = await sendPush(sub, message, env, fetchImpl);
    if (r === 'ok') {
      ok++;
      await env.DB.prepare('UPDATE push_subscriptions SET last_success_at = ? WHERE id = ?').bind(nowIso(), sub.id).run();
    } else if (r === 'gone') {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
    }
  }
  return { total: results.length, ok };
}
