// Gemini 轉送站：把主要後端送來的請求，加上金鑰後轉給 Google Gemini API
// 只轉送 Gemini API 的路徑，其他一律拒絕；沒有公開網址，外人無法直接呼叫。

const GOOGLE = 'https://generativelanguage.googleapis.com';

/** 去掉金鑰前後看不見的字元（BOM、空白、換行） */
const cleanKey = (raw) => String(raw ?? '').replace(/^﻿/, '').replace(/[^\x21-\x7E]/g, '');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v1beta/models')) return new Response('not found', { status: 404 });
    if (!['GET', 'POST'].includes(request.method)) return new Response('method not allowed', { status: 405 });

    const key = cleanKey(env.GEMINI_API_KEY);
    if (!key) return Response.json({ error: { code: 503, message: 'relay has no key' } }, { status: 503 });

    return fetch(`${GOOGLE}${url.pathname}${url.search}`, {
      method: request.method,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: request.method === 'POST' ? request.body : undefined,
    });
  },
};
