// 本機整合測試：帳本、邀請碼、權限（第 4 階段）
// 前提：本機後端正在執行（npm run dev），並已執行 npm run seed:local 準備測試帳號。
// 執行方式：node test/local-api-check.mjs
// 三個假帳號：A（呱呱）、B（咩咩）、C（路人）；不需要真的 Google 登入。

const BASE = process.env.API_BASE || 'http://localhost:8787';
export const TEST_TOKENS = { A: 'test-token-aaaa-0000000000000000', B: 'test-token-bbbb-0000000000000000', C: 'test-token-cccc-0000000000000000' };

async function call(who, method, path, body, origin) {
  const headers = {};
  if (who) headers.Authorization = `Bearer ${TEST_TOKENS[who]}`;
  if (body) headers['Content-Type'] = 'application/json';
  if (origin) headers.Origin = origin;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers };
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✔ ${name}`); } else { fail++; console.log(`✖ ${name}`, detail ?? ''); }
}

const r1 = await call(null, 'GET', '/api/me');
check('沒登入讀取資料 → 回應「請先登入」(401)', r1.status === 401, r1);

const bad = await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer fake-token' } });
check('假通行證 → 401', bad.status === 401);

const a0 = await call('A', 'GET', '/api/me');
check('A 登入後還沒有小窩', a0.status === 200 && a0.data.ledger === null, a0);

const a1 = await call('A', 'POST', '/api/ledgers', { nickname: '呱呱' });
const code = a1.data.ledger?.invite?.code;
check('A 建立小窩並拿到邀請碼', a1.status === 201 && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code || ''), a1);

const a2 = await call('A', 'POST', '/api/ledgers', { nickname: '呱呱' });
check('A 不能再建第二個小窩', a2.status === 409, a2);

const b0 = await call('B', 'POST', '/api/ledgers/join', { code: 'ZZZZ-9999', nickname: '咩咩' });
check('錯誤的邀請碼 → 無效', b0.status === 404, b0);

const b1 = await call('B', 'POST', '/api/ledgers/join', { code: code.toLowerCase().replace('-', ' '), nickname: '咩咩' });
check('B 用邀請碼加入（大小寫、空格都能接受）', b1.status === 200 && b1.data.ledger.members.length === 2, b1);

const c1 = await call('C', 'POST', '/api/ledgers/join', { code, nickname: '路人' });
check('C 用同一組邀請碼 → 已被用過', c1.status === 404, c1);

const a3 = await call('A', 'POST', '/api/ledgers/invite');
check('滿 2 人後不能再產生邀請碼', a3.status === 409, a3);

const c2 = await call('C', 'POST', '/api/ledgers', { nickname: '路人' });
check('C 自己建立另一個小窩', c2.status === 201, c2);

const cMe = await call('C', 'GET', '/api/me');
const aMe = await call('A', 'GET', '/api/me');
check('帳本彼此隔離：C 只看得到自己的小窩', cMe.data.ledger.members.length === 1 && cMe.data.ledger.id !== aMe.data.ledger.id);
check('A 看到的成員是呱呱與咩咩', aMe.data.ledger.members.map((m) => m.nickname).join(',') === '呱呱,咩咩', aMe.data.ledger.members);

const n1 = await call('B', 'PATCH', '/api/me/nickname', { nickname: '咩咩寶' });
check('B 修改暱稱', n1.status === 200 && n1.data.ledger.members.some((m) => m.nickname === '咩咩寶'));

const p1 = await call('A', 'POST', '/api/me/privacy-ack');
const aMe2 = await call('A', 'GET', '/api/me');
check('隱私提醒按「我知道了」後會記住', p1.status === 200 && aMe2.data.user.privacyAcknowledged === true);

// ───── 第 5 階段：記帳 ─────
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(Date.now() - 86400000));
const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(Date.now() + 86400000));

const ps1 = await call('B', 'POST', '/api/parse', { text: '昨天幫呱呱付晚餐 350' });
check('B 解析「昨天幫呱呱付晚餐 350」→ 四個欄位都抓到', ps1.status === 200 && ps1.data.missing.length === 0
  && ps1.data.fields.amount === 350 && ps1.data.fields.direction === 'me_lent' && ps1.data.fields.item === '晚餐' && ps1.data.fields.date === yesterday, ps1.data);

const ps2 = await call('B', 'POST', '/api/parse', { text: '晚餐 350', draft: null });
check('缺漏時會追問誰欠誰', ps2.data.missing.join(',') === 'direction,date' && /借給/.test(ps2.data.question), ps2.data);

const ps3 = await call('B', 'POST', '/api/parse', { text: '呱呱欠我 今天', draft: ps2.data.fields });
check('回答追問後草稿補齊（金額與項目保留）', ps3.data.missing.length === 0 && ps3.data.fields.amount === 350 && ps3.data.fields.date === today, ps3.data);

const cl0 = await call('B', 'POST', '/api/loans', { amount: 350, direction: 'me_lent', item: '', date: today });
check('欄位沒填完不能送出', cl0.status === 400, cl0.data);

const cl1 = await call('B', 'POST', '/api/loans', { amount: 350, direction: 'me_lent', item: '晚餐', date: tomorrow });
check('日期不能是未來', cl1.status === 400, cl1.data);

const cl2 = await call('B', 'POST', '/api/loans', { ...ps1.data.fields, parseSource: 'rules' });
check('B 送出一筆 → 狀態是「待確認」，呱呱欠咩咩寶', cl2.status === 201 && cl2.data.loan.status === 'pending'
  && cl2.data.loan.borrower.name === '呱呱' && cl2.data.loan.lender.isMe, cl2.data);

const la = await call('A', 'GET', '/api/loans');
check('A 看得到這筆，而且標示「不是我建立的」', la.data.loans.length === 1 && la.data.loans[0].createdByMe === false && la.data.loans[0].borrower.isMe, la.data);

const pc = await call('C', 'POST', '/api/parse', { text: '晚餐 100' });
check('C 的小窩只有一個人 → 不能記帳', pc.status === 409, pc.data);

const lc = await call('C', 'GET', '/api/loans');
check('帳本隔離：C 看不到 A、B 的借款', lc.status === 200 && lc.data.loans.length === 0, lc.data);

// ───── 第 7 階段：同意、否定、撤回、修改重送 ─────
const loanId = cl2.data.loan.id;
const newLoan = async (who, extra = {}) =>
  (await call(who, 'POST', '/api/loans', { amount: 100, direction: 'me_lent', item: '測試', date: today, ...extra })).data.loan.id;

const s1 = await call('B', 'POST', `/api/loans/${loanId}/approve`);
check('自己記的帳不能自己同意', s1.status === 403, s1.data);

const s2 = await call('A', 'POST', `/api/loans/${loanId}/reject`, { reason: '金額不對' });
check('A 否定 B 的帳（附原因）→ 變成「被否定」', s2.status === 200 && s2.data.loan.status === 'rejected' && s2.data.loan.rejectReason === '金額不對', s2.data);

const s3 = await call('A', 'POST', `/api/loans/${loanId}/approve`);
check('已否定的帳不能再同意', s3.status === 409, s3.data);

const s4 = await call('A', 'DELETE', `/api/loans/${loanId}`);
check('被否定的帳，只有記帳的人能刪除', s4.status === 403, s4.data);

const s5 = await call('A', 'PUT', `/api/loans/${loanId}`, { amount: 400, direction: 'partner_lent', item: '晚餐', date: today });
check('對方不能修改我記的帳', s5.status === 403, s5.data);

const s6 = await call('B', 'PUT', `/api/loans/${loanId}`, { amount: 400, direction: 'me_lent', item: '晚餐', date: today });
check('B 修改後重送 → 回到「待確認」，否定原因清除', s6.status === 200 && s6.data.loan.status === 'pending' && s6.data.loan.amount === 400 && !s6.data.loan.rejectReason, s6.data);

const s7 = await call('A', 'POST', `/api/loans/${loanId}/approve`);
check('A 同意 → 變成「未還」', s7.status === 200 && s7.data.loan.status === 'unpaid', s7.data);

const s8 = await call('B', 'POST', `/api/loans/${loanId}/withdraw`);
check('已同意的帳不能撤回', s8.status === 409, s8.data);

const ev = await call('B', 'GET', `/api/loans/${loanId}/events`);
check('狀態紀錄依序為：建立→否定→重送→同意', ev.data.events?.map((e) => e.action).join(',') === 'create,reject,resubmit,approve', ev.data);

const w1 = await newLoan('B');
const w2 = await call('A', 'POST', `/api/loans/${w1}/withdraw`);
check('只有記帳的人可以撤回', w2.status === 403, w2.data);
const w3 = await call('B', 'POST', `/api/loans/${w1}/withdraw`);
const afterW = await call('A', 'GET', '/api/loans');
check('B 撤回 → 這筆消失', w3.status === 200 && !afterW.data.loans.some((l) => l.id === w1), w3.data);

const d1 = await newLoan('B');
await call('A', 'POST', `/api/loans/${d1}/reject`, {});
const d2 = await call('B', 'DELETE', `/api/loans/${d1}`);
check('被否定的帳，記帳的人可以刪除', d2.status === 200, d2.data);

await newLoan('B', { item: '一' });
await newLoan('B', { item: '二' });
const mine = await newLoan('A', { item: 'A自己的' });
const all = await call('A', 'POST', '/api/loans/approve-all');
const afterAll = await call('A', 'GET', '/api/loans');
check('全部同意：只同意對方記的 2 筆，自己記的不受影響', all.data.approved === 2
  && afterAll.data.loans.find((l) => l.id === mine).status === 'pending', all.data);

const x1 = await call('C', 'POST', `/api/loans/${mine}/approve`);
const x2 = await call('C', 'GET', `/api/loans/${loanId}/events`);
check('別的小窩不能操作或查看這本帳的紀錄', x1.status !== 200 && x2.status !== 200, [x1.status, x2.status]);

// ───── 第 8 階段：還款與雙方確認 ─────
// loanId 目前是「未還」（呱呱欠咩咩寶 400）
const pr0 = await call('A', 'POST', `/api/loans/${mine}/repay`);
check('待確認的帳不能標記還款', pr0.status === 409, pr0.data);

const pr1 = await call('A', 'POST', `/api/loans/${loanId}/repay`);
check('A 標記已還款 → 變成「已還待確認」', pr1.status === 200 && pr1.data.loan.status === 'repay_pending' && pr1.data.loan.repayRequestedByMe === true, pr1.data);

const pr2 = await call('A', 'POST', `/api/loans/${loanId}/confirm-repay`);
check('自己標記的還款不能自己確認', pr2.status === 403, pr2.data);

const pr3 = await call('A', 'POST', `/api/loans/${loanId}/repay`);
check('已還待確認時不能重複標記', pr3.status === 409, pr3.data);

const pr4 = await call('A', 'DELETE', `/api/loans/${loanId}`);
check('還沒確認還款前不能刪除', pr4.status === 409, pr4.data);

const pr5 = await call('B', 'POST', `/api/loans/${loanId}/confirm-repay`);
check('B 確認 → 變成「已還」', pr5.status === 200 && pr5.data.loan.status === 'paid' && pr5.data.loan.paidAt, pr5.data);

const evR = await call('A', 'GET', `/api/loans/${loanId}/events`);
check('狀態紀錄多了「標記還款」「確認還款」', evR.data.events.map((e) => e.action).slice(-2).join(',') === 'request_repay,confirm_repay', evR.data);

const pr6 = await call('C', 'DELETE', `/api/loans/${loanId}`);
check('別的小窩不能刪除', pr6.status !== 200, pr6.status);

const pr7 = await call('A', 'DELETE', `/api/loans/${loanId}`);
const afterDel = await call('B', 'GET', '/api/loans');
check('已還的紀錄任一方都能刪除（A 刪 B 記的）', pr7.status === 200 && !afterDel.data.loans.some((l) => l.id === loanId), pr7.data);

// ───── 第 8 階段補充：按錯「已還款」時可以退回 ─────
const u1 = await newLoan('B', { item: '退回測試' });
await call('A', 'POST', `/api/loans/${u1}/approve`);
await call('A', 'POST', `/api/loans/${u1}/repay`);
const uc1 = await call('B', 'POST', `/api/loans/${u1}/cancel-repay`);
check('不是標記的人不能「取消標記」', uc1.status === 403, uc1.data);
const uc2 = await call('A', 'POST', `/api/loans/${u1}/cancel-repay`);
check('標記的人取消標記 → 回到「未還」', uc2.status === 200 && uc2.data.loan.status === 'unpaid' && uc2.data.loan.repayRequestedByMe === null, uc2.data);

await call('A', 'POST', `/api/loans/${u1}/repay`);
const uc3 = await call('A', 'POST', `/api/loans/${u1}/decline-repay`, { reason: 'x' });
check('標記的人不能自己按「還沒收到」', uc3.status === 403, uc3.data);
const uc4 = await call('B', 'POST', `/api/loans/${u1}/decline-repay`, { reason: '還沒收到錢' });
check('對方按「還沒收到」→ 回到「未還」', uc4.status === 200 && uc4.data.loan.status === 'unpaid', uc4.data);
const uc5 = await call('B', 'POST', `/api/loans/${u1}/decline-repay`);
check('未還的帳不能再退回', uc5.status === 409, uc5.data);
const evU = await call('A', 'GET', `/api/loans/${u1}/events`);
const lastU = evU.data.events.slice(-4);
check('狀態紀錄有「取消標記」與「還沒收到（原因）」', lastU.map((e) => e.action).join(',') === 'request_repay,cancel_repay,request_repay,decline_repay'
  && lastU[3].note === '還沒收到錢', evU.data);

// ───── 第 9 階段：統整 ─────
const loansA = (await call('A', 'GET', '/api/loans')).data.loans;
const open = loansA.filter((l) => ['unpaid', 'repay_pending'].includes(l.status));
const expIOwe = open.filter((l) => l.borrower.isMe).reduce((s, l) => s + l.amount, 0);
const expPartner = open.filter((l) => l.lender.isMe).reduce((s, l) => s + l.amount, 0);
const sumA = await call('A', 'GET', '/api/summary');
check('統整（全部）＝手算「未還＋已還待確認」的金額', sumA.status === 200 && sumA.data.me.owes === expIOwe && sumA.data.partner.owes === expPartner
  && sumA.data.count === open.length, { expIOwe, expPartner, got: sumA.data });

const sumB = await call('B', 'GET', '/api/summary');
check('兩個人看到的統整一致（我與對方互換）', sumB.data.me.owes === sumA.data.partner.owes && sumB.data.partner.owes === sumA.data.me.owes
  && sumB.data.net?.amount === sumA.data.net?.amount && sumB.data.net?.toMe === !sumA.data.net?.toMe, sumB.data);

await newLoan('A', { amount: 5000, item: '還沒同意的' });
const sumA2 = await call('A', 'GET', '/api/summary');
check('待確認的帳不算進統整', sumA2.data.me.owes === sumA.data.me.owes && sumA2.data.partner.owes === sumA.data.partner.owes, sumA2.data);

const lastMonthDate = (() => {
  const [y, m] = today.split('-').map(Number);
  return m === 1 ? `${y - 1}-12-15` : `${y}-${String(m - 1).padStart(2, '0')}-15`;
})();
const lm = await newLoan('A', { amount: 1000, item: '上個月的', date: lastMonthDate });
await call('B', 'POST', `/api/loans/${lm}/approve`);
const sumM = await call('A', 'GET', `/api/summary?month=${lastMonthDate.slice(0, 7)}`);
check('指定月份：只算那個月 → 咩咩寶要給我 1000', sumM.data.count === 1 && sumM.data.partner.owes === 1000 && sumM.data.me.owes === 0
  && sumM.data.net.toMe === true && sumM.data.net.amount === 1000, sumM.data);
check('月份選單包含上個月與這個月', sumM.data.months.includes(lastMonthDate.slice(0, 7)) && sumM.data.months.includes(today.slice(0, 7)), sumM.data.months);

const sumBad = await call('A', 'GET', '/api/summary?month=2026-13');
check('錯誤的月份格式 → 拒絕', sumBad.status === 400, sumBad.data);
const sumC = await call('C', 'GET', '/api/summary');
check('只有一個人的小窩沒有統整', sumC.status === 409, sumC.data);

// ───── 第 10 階段：語音 ─────
const v1 = await call('A', 'POST', '/api/parse-voice', { audio: { mimeType: 'audio/webm', base64: 'AAAA' } });
check('語音：不接受 WAV 以外的格式', v1.status === 400, v1.data);
const v2 = await call('A', 'POST', '/api/parse-voice', { audio: { mimeType: 'audio/wav', base64: 'A'.repeat(1_500_000) } });
check('語音：超過 30 秒的錄音 → 拒絕', v2.status === 413, v2.data);
const v3 = await call(null, 'POST', '/api/parse-voice', { audio: { mimeType: 'audio/wav', base64: 'UklGRg==' } });
check('語音：沒登入 → 拒絕', v3.status === 401, v3.data);
const v4 = await call('A', 'POST', '/api/parse-voice', { audio: { mimeType: 'audio/wav', base64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=' } });
check('語音：格式正確 → 有回應（本機沒有 Gemini 金鑰，所以請使用者改用打字）', v4.status === 200 && /打字|鍵盤/.test(v4.data.question), v4.data);

// ───── 第 11 階段：網頁推播訂閱 ─────
const fakeKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const fakeAuth = Buffer.alloc(16, 9).toString('base64url');
const ps0 = await call('A', 'POST', '/api/push/subscribe', { endpoint: 'https://evil.example/push', keys: { p256dh: fakeKey, auth: fakeAuth } });
check('推播：不接受正式推播服務以外的地址', ps0.status === 400, ps0.data);
const psK = await call('A', 'POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/test1', keys: { p256dh: 'abc', auth: fakeAuth } });
check('推播：鑰匙格式錯誤 → 拒絕', psK.status === 400, psK.data);
const psOk = await call('A', 'POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/test1', keys: { p256dh: fakeKey, auth: fakeAuth } });
const psAgain = await call('A', 'POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/test1', keys: { p256dh: fakeKey, auth: fakeAuth } });
check('推播：開啟通知成功（重複開啟不會出錯）', psOk.status === 200 && psAgain.status === 200, [psOk.data, psAgain.data]);
const psN = await call(null, 'POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: fakeKey, auth: fakeAuth } });
check('推播：沒登入不能訂閱', psN.status === 401, psN.data);
const psT = await call('A', 'POST', '/api/push/test');
check('推播：本機沒有 VAPID 私鑰時，測試通知回報「尚未設定」', psT.status === 503, psT.data);
const psOff = await call('A', 'POST', '/api/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/test1' });
check('推播：關閉通知成功', psOff.status === 200, psOff.data);
const nb = await newLoan('B', { item: '通知測試' });
const na = await call('A', 'POST', `/api/loans/${nb}/approve`);
check('有通知流程時，記帳與同意照常成功', Boolean(nb) && na.status === 200, na.data);

const evil = await call('A', 'GET', '/api/me', undefined, 'https://evil.example');
check('陌生網站呼叫 → 瀏覽器不放行（沒有 CORS 許可標頭）', !evil.headers.get('access-control-allow-origin'));

const st = await fetch(BASE + '/api/auth/google/start?nonce_hash=short', { redirect: 'manual' });
check('登入請求缺少暗號 → 拒絕', st.status === 400);

const ex = await call(null, 'POST', '/api/auth/exchange', { login_code: 'fake', nonce: 'fake' });
check('假的登入兌換券 → 拒絕', ex.status === 401, ex);

const lo = await call('C', 'POST', '/api/auth/logout');
const afterLogout = await call('C', 'GET', '/api/me');
check('登出後通行證立即失效', lo.status === 200 && afterLogout.status === 401);

console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
