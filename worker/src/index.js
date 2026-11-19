// 呱咩小窩帳｜後端入口
// 第 2 階段只有「健康檢查」，用來確認網頁能連上後端。
// 之後各階段會在 routes 裡加入登入、帳本、記帳、LINE 等功能。

import { corsHeaders, handlePreflight } from './cors.js';

/** 回傳 JSON 格式的回應，並附上 CORS 標頭 */
function json(request, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request, env),
    },
  });
}

// 路由表：「方法 路徑」對應到處理函式
const routes = {
  'GET /api/health': (request, env) =>
    json(request, env, {
      ok: true,
      app: '呱咩小窩帳',
      message: '呱呱～咩咩～後端運作正常！',
      time: new Date().toISOString(),
    }),
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return handlePreflight(request, env);

    const { pathname } = new URL(request.url);
    const handler = routes[`${request.method} ${pathname}`];
    if (!handler) return json(request, env, { ok: false, error: '找不到這個功能' }, 404);

    try {
      return await handler(request, env);
    } catch (err) {
      // 錯誤細節只記在後端紀錄，不回傳給使用者，避免洩漏內部資訊
      console.error(err);
      return json(request, env, { ok: false, error: '後端發生錯誤，請稍後再試' }, 500);
    }
  },
};
