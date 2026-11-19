// 統一發送通知（第 11 階段：網頁推播；第 12 階段：LINE）
// 通知在背景送出（waitUntil），不會讓按鈕等待；送不出去也不影響記帳本身。

import { pushToUser } from './push.js';
import { notifyLine } from './lineApi.js';

/**
 * 通知種類：
 *  new_pending     有新借款待確認（通知對方）
 *  rejected        被否定（通知記帳的人）
 *  resubmitted     修改後重送（通知對方）
 *  repay_pending   還款待確認（通知另一方）
 *  repay_confirmed 還款已確認（通知標記的人）
 *  repay_declined  對方表示還沒收到還款（通知標記的人）
 */
const TEMPLATES = {
  new_pending: (a, l) => `📒 ${a} 記了一筆帳：${l}，等你確認`,
  rejected: (a, l, note) => `❌ ${a} 否定了：${l}${note ? `（${note}）` : ''}`,
  resubmitted: (a, l) => `✏️ ${a} 修改後重送：${l}，等你確認`,
  repay_pending: (a, l) => `💰 ${a} 標記已還款：${l}，請確認`,
  repay_confirmed: (a, l) => `🎉 ${a} 確認收到還款：${l}`,
  repay_declined: (a, l, note) => `🤔 ${a} 表示還沒收到還款：${l}${note ? `（${note}）` : ''}`,
};

/** 組出通知文字（查詢借款與操作者暱稱） */
export async function buildMessage(env, { type, loanId, actorId, note }) {
  const row = await env.DB.prepare(
    `SELECT l.item, l.amount, m.nickname AS actor
       FROM loans l LEFT JOIN ledger_members m ON m.ledger_id = l.ledger_id AND m.user_id = ?
      WHERE l.id = ?`,
  ).bind(actorId, loanId).first();
  if (!row || !TEMPLATES[type]) return null;
  const loanText = `${row.item} $${Number(row.amount).toLocaleString('en-US')}`;
  return {
    title: '呱咩小窩帳',
    body: TEMPLATES[type](row.actor || '對方', loanText, note),
    url: env.FRONTEND_URL,
    tag: `loan-${loanId}`,
  };
}

/** 送出通知；在 Cloudflare 上會交給背景執行，不拖慢畫面 */
export function notify(env, { type, toUserId, loanId, actorId, note = null }) {
  const job = (async () => {
    try {
      const message = await buildMessage(env, { type, loanId, actorId, note });
      if (!message) return;
      // 網頁推播與 LINE 同時送出，確保送達（LINE 超過每月免費額度時自動略過）
      await Promise.all([
        pushToUser(env, toUserId, message),
        notifyLine(env, { toUserId, type, loanId, body: message.body }),
      ]);
    } catch (err) {
      console.warn('通知失敗', type, err?.message);
    }
  })();
  if (env.waitUntil) env.waitUntil(job);
  return job;
}
