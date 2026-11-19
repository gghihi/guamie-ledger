// CORS（跨網站存取規則）：只允許我們自己的 GitHub Pages 網站呼叫後端。
// 白話：別的網站就算知道後端網址，瀏覽器也會擋下它的請求。

// 本機開發時用的網址（只有在 wrangler dev 本機模式下才放行）
const LOCAL_DEV_ORIGINS = ['http://localhost:5500', 'http://127.0.0.1:5500'];

/** 取得允許的網站清單 */
export function allowedOrigins(env, request) {
  const list = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // 後端本身跑在 localhost 時，代表是本機開發，才額外允許本機前端
  const host = new URL(request.url).hostname;
  if (host === 'localhost' || host === '127.0.0.1') list.push(...LOCAL_DEV_ORIGINS);
  return list;
}

/** 依照請求來源，產生要附加的 CORS 標頭；來源不在名單內則回傳空物件 */
export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins(env, request).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    // 前端用 Authorization 標頭帶通行證（Token），不使用 Cookie
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** 瀏覽器正式送出請求前的「預檢」詢問 */
export function handlePreflight(request, env) {
  const headers = corsHeaders(request, env);
  if (!headers['Access-Control-Allow-Origin']) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers });
}
