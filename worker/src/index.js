// 呱咩小窩帳｜後端入口：把每個網址分派給對應的功能

import { handlePreflight } from './cors.js';
import { HttpError, json } from './util.js';
import { googleStart, googleCallback, exchangeLoginCode, logout } from './auth.js';
import { getMe, ackPrivacy, updateNickname, createLedger, regenerateInvite, joinLedger } from './ledgers.js';
import { parseText, createLoan, listLoans } from './loans.js';
import { getSummary } from './summary.js';
import {
  approveLoan, approveAll, rejectLoan, withdrawLoan, resubmitLoan, deleteLoan, loanEvents,
  requestRepay, confirmRepay, cancelRepay, declineRepay,
} from './loanActions.js';

async function health(request, env) {
  // 順便確認資料庫連得上（只數資料表數量，不讀任何帳目內容）
  let database = false;
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('users','ledgers','loans')",
    ).first();
    database = row?.n === 3;
  } catch (err) {
    console.error('資料庫檢查失敗', err);
  }
  return json(request, env, {
    ok: true,
    database,
    app: '呱咩小窩帳',
    message: database ? '呱呱～咩咩～後端與資料庫都正常！' : '後端正常，但資料庫還沒準備好',
    time: new Date().toISOString(),
  });
}

// 路由表：「方法 路徑」對應到處理函式
const routes = {
  'GET /api/health': health,

  // 登入
  'GET /api/auth/google/start': googleStart,
  'GET /api/auth/google/callback': googleCallback,
  'POST /api/auth/exchange': exchangeLoginCode,
  'POST /api/auth/logout': logout,

  // 我與小窩
  'GET /api/me': getMe,
  'POST /api/me/privacy-ack': ackPrivacy,
  'PATCH /api/me/nickname': updateNickname,
  'POST /api/ledgers': createLedger,
  'POST /api/ledgers/invite': regenerateInvite,
  'POST /api/ledgers/join': joinLedger,

  // 記帳
  'POST /api/parse': parseText,
  'GET /api/loans': listLoans,
  'POST /api/loans': createLoan,
  'POST /api/loans/approve-all': approveAll,

  // 統整
  'GET /api/summary': getSummary,
};

// 帶有編號的路由，例如 /api/loans/1234/approve
const ID = '([0-9a-f-]{36})';
const paramRoutes = [
  ['POST', new RegExp(`^/api/loans/${ID}/approve$`), approveLoan],
  ['POST', new RegExp(`^/api/loans/${ID}/reject$`), rejectLoan],
  ['POST', new RegExp(`^/api/loans/${ID}/withdraw$`), withdrawLoan],
  ['PUT', new RegExp(`^/api/loans/${ID}$`), resubmitLoan],
  ['DELETE', new RegExp(`^/api/loans/${ID}$`), deleteLoan],
  ['GET', new RegExp(`^/api/loans/${ID}/events$`), loanEvents],
  ['POST', new RegExp(`^/api/loans/${ID}/repay$`), requestRepay],
  ['POST', new RegExp(`^/api/loans/${ID}/confirm-repay$`), confirmRepay],
  ['POST', new RegExp(`^/api/loans/${ID}/cancel-repay$`), cancelRepay],
  ['POST', new RegExp(`^/api/loans/${ID}/decline-repay$`), declineRepay],
];

function findRoute(method, pathname) {
  const exact = routes[`${method} ${pathname}`];
  if (exact) return { handler: exact, params: {} };
  for (const [m, re, handler] of paramRoutes) {
    const match = m === method && pathname.match(re);
    if (match) return { handler, params: { id: match[1] } };
  }
  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return handlePreflight(request, env);

    const { pathname } = new URL(request.url);
    const route = findRoute(request.method, pathname);
    if (!route) return json(request, env, { ok: false, error: '找不到這個功能' }, 404);

    try {
      return await route.handler(request, env, route.params);
    } catch (err) {
      if (err instanceof HttpError) {
        return json(request, env, { ok: false, error: err.message, code: err.code }, err.status);
      }
      // 錯誤細節只記在後端紀錄，不回傳給使用者，避免洩漏內部資訊
      console.error(err);
      return json(request, env, { ok: false, error: '後端發生錯誤，請稍後再試' }, 500);
    }
  },
};
