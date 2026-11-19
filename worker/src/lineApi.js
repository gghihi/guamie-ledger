// LINE Messaging API 共用小工具與 LINE 通知（給 line.js 與 notify.js 使用）
// 回覆訊息不計入 LINE 免費額度；主動推送（通知）才會計入，所以這裡會記錄每月用量。

import { todayIn } from './parse/dates.js';

const LINE_API = 'https://api.line.me/v2/bot';

export async function lineFetch(env, path, payload) {
  const res = await (env.lineFetch || fetch)(`${LINE_API}${path}`, {
    method: payload ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!res.ok) console.warn('LINE API 失敗', path, res.status);
  return res;
}

export const replyLine = (env, replyToken, messages) => lineFetch(env, '/message/reply', { replyToken, messages: [].concat(messages) });
export const pushLine = (env, to, messages) => lineFetch(env, '/message/push', { to, messages: [].concat(messages) });

export const text = (t, quickReply) => ({ type: 'text', text: t.slice(0, 4900), ...(quickReply ? { quickReply } : {}) });
export const postback = (label, data, displayText) => ({ type: 'action', action: { type: 'postback', label: label.slice(0, 20), data, displayText: displayText || label } });
export const confirmTemplate = (altText, body, yes, no) => ({
  type: 'template',
  altText: altText.slice(0, 400),
  template: {
    type: 'confirm',
    text: body.slice(0, 240),
    actions: [
      { type: 'postback', label: yes.label, data: yes.data, displayText: yes.displayText || yes.label },
      { type: 'postback', label: no.label, data: no.data, displayText: no.displayText || no.label },
    ],
  },
});

export const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

// ───────── LINE 通知（給 notify.js 使用） ─────────

/** 本月（台灣時間）還能不能發 LINE 主動通知；能的話先記一筆 */
export async function takeMonthlyQuota(env) {
  const limit = Number(env.LINE_MONTHLY_PUSH_LIMIT || 180);
  const month = todayIn(env.APP_TIMEZONE || 'Asia/Taipei').slice(0, 7);
  const row = await env.DB.prepare(
    `INSERT INTO line_push_usage (month, sent_count) VALUES (?, 1)
     ON CONFLICT(month) DO UPDATE SET sent_count = sent_count + 1 WHERE sent_count < ?
     RETURNING sent_count`,
  ).bind(month, limit).first();
  return Boolean(row);
}

/** 用 LINE 通知某位使用者（有綁定才送；超過每月額度就不送，改靠網頁推播） */
export async function notifyLine(env, { toUserId, type, loanId, body }) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return 'not_configured';
  const binding = await env.DB.prepare('SELECT line_user_id FROM line_bindings WHERE user_id = ?').bind(toUserId).first();
  if (!binding) return 'not_bound';
  if (!(await takeMonthlyQuota(env))) {
    console.warn('LINE 本月免費通知額度已用完，改靠網頁推播');
    return 'quota_exceeded';
  }
  const withButtons = type === 'new_pending' || type === 'resubmitted';
  const message = withButtons
    ? confirmTemplate(body, body, { label: '同意', data: `a=ask_approve&id=${loanId}` }, { label: '否定', data: `a=ask_reject&id=${loanId}` })
    : text(body);
  const res = await pushLine(env, binding.line_user_id, message);
  return res.ok ? 'ok' : 'error';
}
