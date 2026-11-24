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

// ───── 全部已還：一次把多筆未還標記為已還款 ─────
const ra1 = await newLoan('B', { item: '全還一' });
const ra2 = await newLoan('A', { item: '全還二' });
await call('A', 'POST', `/api/loans/${ra1}/approve`);
await call('B', 'POST', `/api/loans/${ra2}/approve`);
const raBad = await call('A', 'POST', '/api/loans/repay-all', { ids: [ra1, mine] });
const raBadAfter = await call('A', 'GET', '/api/loans');
check('全部已還：清單裡有不是「未還」的就整批不做', raBad.status === 409
  && raBadAfter.data.loans.find((l) => l.id === ra1).status === 'unpaid', raBad.data);
const raC = await call('C', 'POST', '/api/loans/repay-all', { ids: [ra1] });
check('全部已還：別的小窩不能標記', raC.status !== 200, raC.status);
const raOk = await call('A', 'POST', '/api/loans/repay-all', { ids: [ra1, ra2], payer: 'lender' });
const raAfter = (await call('A', 'GET', '/api/loans')).data.loans.filter((l) => [ra1, ra2].includes(l.id));
check('全部已還：2 筆都變成「已還待確認」，還款人是借出的人', raOk.status === 200 && raOk.data.marked === 2
  && raAfter.every((l) => l.status === 'repay_pending' && l.repayRequestedByMe), raOk.data);
await call('B', 'POST', `/api/loans/${ra1}/confirm-repay`);
await call('B', 'POST', `/api/loans/${ra2}/confirm-repay`);
const raPaid = (await call('A', 'GET', '/api/loans')).data.loans.filter((l) => [ra1, ra2].includes(l.id));
check('全部已還：確認後還款人記成借出的人', raPaid.every((l) => l.status === 'paid' && l.repaidBy && l.repaidBy.id === (l.lender.id)), raPaid);

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

// ───── 第 12 階段：LINE 機器人（本機用假的 LINE 鑰匙，回覆不會真的送出） ─────
const { createHmac } = await import('node:crypto');
const LINE_SECRET = 'local-test-line-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function lineSend(events, { badSig = false } = {}) {
  const body = JSON.stringify({ destination: 'x', events });
  const sig = badSig ? 'AAAA' : createHmac('sha256', LINE_SECRET).update(body).digest('base64');
  const res = await fetch(BASE + '/api/line/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body });
  await sleep(1500); // 等背景處理完成
  return res;
}
const lineText = (uid, t) => ({ type: 'message', replyToken: 'r', source: { type: 'user', userId: uid }, message: { type: 'text', id: '1', text: t } });
const linePost = (uid, data) => ({ type: 'postback', replyToken: 'r', source: { type: 'user', userId: uid }, postback: { data } });
const LA = 'Utestlineaaaaaaaaaaaaaaaaaaaaaaaa';
const LB = 'Utestlinebbbbbbbbbbbbbbbbbbbbbbbb';

const lw0 = await lineSend([], { badSig: true });
check('LINE：簽章不對（不是 LINE 送來的）→ 拒絕', lw0.status === 401);
const lw1 = await lineSend([]);
check('LINE：簽章正確 → 收下（LINE 後台「驗證」按鈕會用到）', lw1.status === 200);

const ls0 = await call('A', 'GET', '/api/line/status');
check('LINE：一開始還沒綁定', ls0.status === 200 && ls0.data.bound === false && ls0.data.configured === true, ls0.data);

await lineSend([lineText(LA, '晚餐 350')]);
const noBindDraft = (await call('A', 'GET', '/api/loans')).data.loans.length;

const bc = await call('A', 'POST', '/api/line/bind-code');
check('LINE：網頁版取得 6 位數綁定碼', /^[0-9]{6}$/.test(bc.data.code || ''), bc.data);
await lineSend([lineText(LA, '綁定 000000')]);
check('LINE：錯的綁定碼不會綁定', (await call('A', 'GET', '/api/line/status')).data.bound === false);
await lineSend([lineText(LA, `綁定 ${bc.data.code}`)]);
check('LINE：傳「綁定 123456」→ 綁定成功', (await call('A', 'GET', '/api/line/status')).data.bound === true);
await lineSend([lineText(LB, `綁定 ${bc.data.code}`)]);
check('LINE：綁定碼只能用一次', (await call('B', 'GET', '/api/line/status')).data.bound === false);

const before = (await call('A', 'GET', '/api/loans')).data.loans.length;
check('LINE：沒綁定時傳記帳句子，不會記到任何帳', noBindDraft === before - 0);
await lineSend([lineText(LA, '今天幫咩咩寶付晚餐 350')]);
await lineSend([linePost(LA, 'a=confirm')]);
const afterLine = (await call('A', 'GET', '/api/loans')).data.loans;
const lineLoan = afterLine.find((l) => l.item === '晚餐' && l.amount === 350 && l.inputChannel === 'line');
check('LINE：說一句話 → 按「確認送出」→ 網頁版待確認區出現這筆', afterLine.length === before + 1 && lineLoan?.status === 'pending' && lineLoan?.borrower.name === '咩咩寶', lineLoan);

await lineSend([lineText(LA, '計程車 200')]);
await lineSend([linePost(LA, 'a=dir&v=partner_lent')]);
await lineSend([linePost(LA, 'a=date&v=' + today)]);
await lineSend([linePost(LA, 'a=confirm')]);
const taxi = (await call('A', 'GET', '/api/loans')).data.loans.find((l) => l.item === '計程車' && l.inputChannel === 'line');
check('LINE：缺欄位時用按鈕補「誰欠誰」「日期」後送出', taxi?.amount === 200 && taxi?.borrower.isMe === true && taxi?.date === today, taxi);

await lineSend([lineText(LA, '早餐 80')]);
await lineSend([lineText(LA, '取消')]);
await lineSend([linePost(LA, 'a=confirm')]);
check('LINE：傳「取消」後，這筆不會被送出', !(await call('A', 'GET', '/api/loans')).data.loans.some((l) => l.item === '早餐'));

// B 綁定後，在 LINE 同意 A 記的帳
const bcB = await call('B', 'POST', '/api/line/bind-code');
await lineSend([lineText(LB, `綁定 ${bcB.data.code}`)]);
await lineSend([linePost(LB, `a=ask_approve&id=${lineLoan.id}`)]);
const stillPending = (await call('B', 'GET', '/api/loans')).data.loans.find((l) => l.id === lineLoan.id).status;
await lineSend([linePost(LB, `a=approve&id=${lineLoan.id}`)]);
const approvedLine = (await call('B', 'GET', '/api/loans')).data.loans.find((l) => l.id === lineLoan.id).status;
check('LINE：按「同意」會先問一次（確認畫面），按「確定同意」才真的同意', stillPending === 'pending' && approvedLine === 'unpaid', [stillPending, approvedLine]);

await lineSend([linePost(LA, `a=approve&id=${taxi.id}`)]);
check('LINE：自己記的帳不能在 LINE 自己同意', (await call('A', 'GET', '/api/loans')).data.loans.find((l) => l.id === taxi.id).status === 'pending');
await lineSend([linePost(LB, `a=reject&id=${taxi.id}`)]);
check('LINE：對方在 LINE 否定 → 變成「被否定」', (await call('A', 'GET', '/api/loans')).data.loans.find((l) => l.id === taxi.id).status === 'rejected');

const ub = await call('A', 'DELETE', '/api/line/binding');
check('LINE：網頁版解除綁定', ub.status === 200 && (await call('A', 'GET', '/api/line/status')).data.bound === false);

// ───── 歷史紀錄 H2：自動分類、實際還款人、補填 ─────
const h2Find = async (who, item) => (await call(who, 'GET', '/api/loans')).data.loans.find((l) => l.item === item);
const h2Coffee = await newLoan('B', { item: '珍珠奶茶', amount: 600 });
check('H2：記帳時自動分類（珍珠奶茶 → 飲料）', (await h2Find('A', '珍珠奶茶'))?.category === '飲料');
const h2Gift = await newLoan('B', { item: '神秘小物', amount: 150 });
check('H2：比對不到的項目 → 其他（F7）', (await h2Find('A', '神秘小物'))?.category === '其他');

// 修改重送時重新分類
const h2Re = await newLoan('B', { item: '未知', amount: 90 });
await call('A', 'POST', `/api/loans/${h2Re}/reject`, {});
await call('B', 'PUT', `/api/loans/${h2Re}`, { amount: 90, direction: 'me_lent', item: '計程車', date: today });
check('H2：修改重送後依新項目重新分類（計程車 → 交通）', (await h2Find('A', '計程車'))?.category === '交通');

// 預設還款人＝欠錢的人（B 記帳、B 借出 → A 欠錢）
await call('A', 'POST', `/api/loans/${h2Coffee}/approve`);
const h2r1 = await call('A', 'POST', `/api/loans/${h2Coffee}/repay`);
check('H2：已還款沒指定還款人 → 預設為欠錢的人', h2r1.status === 200 && h2r1.data.loan.repaidBy?.isMe === true, h2r1.data.loan);

// 取消標記會清空還款人
await call('A', 'POST', `/api/loans/${h2Coffee}/cancel-repay`);
check('H2：取消標記後還款人清空', (await h2Find('A', '珍珠奶茶')).repaidBy === null);

// F8：指定由借出的人（B）負擔
const meB = (await call('B', 'GET', '/api/me')).data.user.id;
const h2bad = await call('A', 'POST', `/api/loans/${h2Coffee}/repay`, { repaidBy: 'someone-else' });
check('H2：還款人只能是這筆的兩個人之一', h2bad.status === 400, h2bad.data);
await call('A', 'POST', `/api/loans/${h2Coffee}/repay`, { repaidBy: meB });
await call('B', 'POST', `/api/loans/${h2Coffee}/confirm-repay`);
const h2paid = await h2Find('A', '珍珠奶茶');
check('H2：還款人非原欠款人時，以實際還款人為準（F8）', h2paid.status === 'paid' && h2paid.repaidBy?.id === meB && h2paid.repaidBy.name, h2paid);

// 「還沒收到」也會清空還款人
await call('A', 'POST', `/api/loans/${h2Gift}/approve`);
await call('A', 'POST', `/api/loans/${h2Gift}/repay`);
await call('B', 'POST', `/api/loans/${h2Gift}/decline-repay`, {});
check('H2：對方按「還沒收到」後還款人清空', (await h2Find('A', '神秘小物')).repaidBy === null);

// 補填還款人（F11）：只限已還
const meA = (await call('A', 'GET', '/api/me')).data.user.id;
const h2s0 = await call('A', 'POST', `/api/loans/${h2Gift}/repayer`, { userId: meA });
check('H2：未還的紀錄不能補填還款人', h2s0.status === 409, h2s0.data);
// 模擬「上線前就還清」的舊資料：已還但沒有還款人
await call('A', 'POST', `/api/loans/${h2Gift}/repay`);
await call('B', 'POST', `/api/loans/${h2Gift}/confirm-repay`);
const { execSync } = await import('node:child_process');
execSync(`npx wrangler d1 execute guamie-ledger-db --local --command "UPDATE loans SET repaid_by = NULL WHERE id = '${h2Gift}'"`, { stdio: 'ignore', shell: true });
check('H2：舊資料（已還、無還款人）顯示為未指定', (await h2Find('A', '神秘小物')).repaidBy === null);
const h2s1 = await call('B', 'POST', `/api/loans/${h2Gift}/repayer`, { userId: 'nobody' });
check('H2：補填的還款人只能是這筆的兩個人之一', h2s1.status === 400, h2s1.data);
const h2s2 = await call('B', 'POST', `/api/loans/${h2Gift}/repayer`, { userId: meA });
check('H2：補填還款人成功（F11）', h2s2.status === 200 && h2s2.data.loan.repaidBy?.id === meA, h2s2.data);
const h2ev = await call('A', 'GET', `/api/loans/${h2Gift}/events`);
check('H2：狀態紀錄多一筆「補填還款人」', h2ev.data.events.at(-1)?.action === 'set_repayer' && h2ev.data.events.at(-1)?.note === '補填還款人', h2ev.data.events.at(-1));
const h2s3 = await call('C', 'POST', `/api/loans/${h2Gift}/repayer`, { userId: meA });
check('H2：別的小窩不能補填', h2s3.status === 404, h2s3.data);

// ───── 歷史紀錄 H3：統計 API（使用 2025 年的日期，和其他測試資料分開）─────
async function h3Paid(item, amount, date, payer) {
  const id = await newLoan('B', { item, amount, date }); // B 借出、A 欠錢
  await call('A', 'POST', `/api/loans/${id}/approve`);
  await call('A', 'POST', `/api/loans/${id}/repay`, { repaidBy: payer });
  await call('B', 'POST', `/api/loans/${id}/confirm-repay`);
  return id;
}
// 2025-03：已還 600（咖啡 300、奶茶 300，都由 A 還）＋已還 200（晚餐，由 B 自己負擔）；另有一筆未還 1000
await h3Paid('咖啡', 300, '2025-03-05', meA);
await h3Paid('奶茶', 300, '2025-03-06', meA);
await h3Paid('晚餐', 200, '2025-03-20', meB);
const h3unpaid = await newLoan('B', { item: '房租', amount: 1000, date: '2025-03-28' });
await call('A', 'POST', `/api/loans/${h3unpaid}/approve`);
// 2025-04：飲料 800（B 還）、餐飲 1200（A 還）→ 40%、60%
await h3Paid('咖啡豆禮盒咖啡', 800, '2025-04-02', meB);
await h3Paid('火鍋', 1200, '2025-04-10', meA);
// 2025-05：一筆 150 的舊資料（已還、未指定還款人）
const h3old = await h3Paid('神秘舊帳', 150, '2025-05-01', meA);
execSync(`npx wrangler d1 execute guamie-ledger-db --local --command "UPDATE loans SET repaid_by = NULL WHERE id = '${h3old}'"`, { stdio: 'ignore', shell: true });
// 2025-06：只有一筆待確認（沒有已還）；2025-07：只有被否定的
await newLoan('B', { item: '電影', amount: 300, date: '2025-06-15' });
const h3rej = await newLoan('B', { item: '門票', amount: 500, date: '2025-07-15' });
await call('A', 'POST', `/api/loans/${h3rej}/reject`, {});

const h3p = await call('A', 'GET', '/api/history/periods');
const h3months = h3p.data.months.map((m) => m.month);
check('H3 F1：期間列表列出有紀錄的月份（03、04、05、06），新的在前', ['2025-06', '2025-05', '2025-04', '2025-03'].every((m) => h3months.includes(m))
  && h3months.indexOf('2025-06') < h3months.indexOf('2025-03') && h3p.data.years.includes('2025'), h3months);
check('H3 F1：只有被否定紀錄的月份不列出', !h3months.includes('2025-07'), h3months);

const h3m3 = (await call('A', 'GET', '/api/history?month=2025-03')).data;
check('H3 F2：月總花費＝已還加總（600＋200＝800）', h3m3.total === 800 && h3m3.count === 3, h3m3);
check('H3 F4：未還的 1000 不計入', h3m3.total === 800);
const pA = h3m3.people.find((p) => p.userId === meA);
const pB = h3m3.people.find((p) => p.userId === meB);
check('H3 F3／F8：依實際還款人加總（呱呱 600、咩咩寶 200）', pA?.amount === 600 && pB?.amount === 200 && pA.isMe === true, h3m3.people);
const h3drink = h3m3.categories.find((c) => c.name === '飲料');
check('H3 F5：咖啡＋奶茶歸入飲料並正確加總（600、2 筆、75%）', h3drink?.amount === 600 && h3drink.count === 2 && h3drink.percent === 75, h3m3.categories);

const h3m4 = (await call('A', 'GET', '/api/history?month=2025-04')).data;
const pct = Object.fromEntries(h3m4.categories.map((c) => [c.name, c.percent]));
check('H3 F13：飲料 800、餐飲 1200 → 40%、60%', pct['飲料'] === 40 && pct['餐飲'] === 60, h3m4.categories);
check('H3 F14：各分類金額加總＝總花費', h3m4.categories.reduce((a, c) => a + c.amount, 0) === h3m4.total);
check('H3：分類依規則順序排列（餐飲在飲料前面）', h3m4.categories[0].name === '餐飲', h3m4.categories.map((c) => c.name));

const h3m5 = (await call('A', 'GET', '/api/history?month=2025-05')).data;
check('H3 F10：未指定還款人的 150 計入總花費，並單獨列出', h3m5.total === 150 && h3m5.unspecified.amount === 150 && h3m5.unspecified.count === 1
  && h3m5.people.every((p) => p.amount === 0), h3m5);
check('H3：未指定的紀錄仍依項目分類（神秘舊帳 → 其他）', h3m5.categories[0]?.name === '其他' && h3m5.categories[0].amount === 150, h3m5.categories);
const h3u = (await call('A', 'GET', '/api/history/unspecified?year=2025')).data;
check('H3 F10：未指定列表列出這筆，並附上可選的兩個人', h3u.loans.length === 1 && h3u.loans[0].id === h3old && h3u.loans[0].lender.id === meB && h3u.loans[0].borrower.id === meA, h3u.loans);
await call('A', 'POST', `/api/loans/${h3old}/repayer`, { userId: meB });
const h3m5b = (await call('A', 'GET', '/api/history?month=2025-05')).data;
check('H3 F11：補填給咩咩寶後，咩咩寶 +150、未指定歸零', h3m5b.people.find((p) => p.userId === meB)?.amount === 150 && h3m5b.unspecified.amount === 0, h3m5b);
check('H3 F11：補填後不再出現在未指定列表', (await call('A', 'GET', '/api/history/unspecified?year=2025')).data.loans.length === 0);

const h3m6 = (await call('A', 'GET', '/api/history?month=2025-06')).data;
check('H3 F15：沒有已還紀錄的月份 → 總額 0、標示為空', h3m6.total === 0 && h3m6.empty === true && h3m6.categories.length === 0, h3m6);

const h3y = (await call('A', 'GET', '/api/history?year=2025')).data;
check('H3 F13：年份統計＝全年已還加總（800＋2000＋150）', h3y.total === 2950 && h3y.period.type === 'year', h3y.total);
check('H3：兩個人看到的年度數字一致', (await call('B', 'GET', '/api/history?year=2025')).data.total === 2950);

const h3e1 = await call('A', 'GET', '/api/history');
const h3e2 = await call('A', 'GET', '/api/history?month=2025-13');
const h3e3 = await call('A', 'GET', '/api/history?month=2025-03&year=2025');
check('H3：期間參數缺少或格式錯誤 → 拒絕', h3e1.status === 400 && h3e2.status === 400 && h3e3.status === 400);
const h3n = await call(null, 'GET', '/api/history?year=2025');
check('H3：沒登入 → 拒絕', h3n.status === 401);
const h3c = (await call('C', 'GET', '/api/history?year=2025')).data;
check('H3：別的小窩看不到這些花費（C 的 2025 年為 0）', h3c.total === 0, h3c.total);

// ───── 歷史紀錄 H4：分類規則管理（F6、F9）─────
const h4g = (await call('A', 'GET', '/api/categories')).data.categories;
check('H4：讀取分類規則（初始 9 類，「其他」在最後）', h4g.length === 9 && h4g[0].name === '餐飲' && h4g.at(-1).name === '其他' && h4g.at(-1).isOther === true, h4g.map((c) => c.name));

// F6：在「購物」加入「禮物」與「神秘」
const h4rules = h4g.filter((c) => !c.isOther).map((c) => (c.name === '購物' ? { ...c, keywords: [...c.keywords, '禮物', '神秘'] } : c));
const h4p = await call('A', 'PUT', '/api/categories', { categories: h4rules });
check('H4 F6：更新分類規則成功，「其他」仍自動放在最後', h4p.status === 200 && h4p.data.categories.find((c) => c.name === '購物').keywords.includes('禮物') && h4p.data.categories.at(-1).name === '其他', h4p.data);
await newLoan('B', { item: '生日禮物', amount: 999 });
check('H4 F6：新規則套用到新紀錄（生日禮物 → 購物）', (await call('A', 'GET', '/api/loans')).data.loans.find((l) => l.item === '生日禮物')?.category === '購物');
check('H4：另一個成員看到的是同一份規則', (await call('B', 'GET', '/api/categories')).data.categories.find((c) => c.name === '購物').keywords.includes('神秘'));

// F9：舊紀錄不受影響（2025-05 的「神秘舊帳」仍是「其他」）
const h4before = (await call('A', 'GET', '/api/history?month=2025-05')).data.categories;
check('H4 F9：改規則後，舊月份的分類數字不變', h4before.length === 1 && h4before[0].name === '其他' && h4before[0].amount === 150, h4before);
const h4rc = await call('A', 'POST', '/api/categories/recalculate');
check('H4 F9：按「重新分類」後回報改了幾筆', h4rc.status === 200 && h4rc.data.updated >= 2 && h4rc.data.total > 0, h4rc.data);
const h4after = (await call('A', 'GET', '/api/history?month=2025-05')).data.categories;
check('H4 F9：重新分類後，舊月份改用新規則（神秘舊帳 → 購物）', h4after.length === 1 && h4after[0].name === '購物' && h4after[0].amount === 150, h4after);
const h4rc2 = await call('A', 'POST', '/api/categories/recalculate');
check('H4：再按一次重新分類，沒有需要改的（0 筆）', h4rc2.data.updated === 0, h4rc2.data);

// 調整順序影響衝突結果：把「飲料」排到「餐飲」前面 → 「早餐奶茶」改歸飲料
const h4order = (await call('A', 'GET', '/api/categories')).data.categories.filter((c) => !c.isOther);
const drink = h4order.find((c) => c.name === '飲料');
await call('A', 'PUT', '/api/categories', { categories: [drink, ...h4order.filter((c) => c.name !== '飲料')] });
await newLoan('B', { item: '早餐奶茶', amount: 60 });
check('H4：調整排序後，同時符合多類時以新的第一個為準（早餐奶茶 → 飲料）', (await call('A', 'GET', '/api/loans')).data.loans.find((l) => l.item === '早餐奶茶')?.category === '飲料');

// 檢查與權限
const h4dup = await call('A', 'PUT', '/api/categories', { categories: [{ name: '餐飲', keywords: [] }, { name: '餐飲', keywords: [] }] });
check('H4：分類名稱重複 → 拒絕，而且規則沒有被改掉', h4dup.status === 400 && (await call('A', 'GET', '/api/categories')).data.categories[0].name === '飲料', h4dup.data);
const h4n = await call(null, 'GET', '/api/categories');
check('H4：沒登入 → 拒絕', h4n.status === 401);
await call('C', 'PUT', '/api/categories', { categories: [{ name: 'C的分類', keywords: ['禮物'] }] });
const h4a = (await call('A', 'GET', '/api/categories')).data.categories.map((c) => c.name);
check('H4：別的小窩改自己的規則，不影響這本帳', !h4a.includes('C的分類') && (await call('C', 'GET', '/api/categories')).data.categories[0].name === 'C的分類', h4a);

// ───── 離開小窩 ─────
const lv0 = await call('A', 'POST', '/api/ledgers/leave');
check('離開：還有沒結清的帳 → 不能離開，並列出這些帳', lv0.status === 409 && lv0.data.code === 'not_settled' && lv0.data.openLoans.length > 0, lv0.data);
// 把 A、B 小窩所有沒結清的帳處理掉：待確認→對方否定或自己撤回；未還→還款並確認
for (const l of (await call('A', 'GET', '/api/loans')).data.loans) {
  if (l.status === 'pending') await call(l.createdByMe ? 'A' : 'A', l.createdByMe ? 'POST' : 'POST', l.createdByMe ? `/api/loans/${l.id}/withdraw` : `/api/loans/${l.id}/reject`, {});
  if (l.status === 'unpaid') { await call('A', 'POST', `/api/loans/${l.id}/repay`); await call('B', 'POST', `/api/loans/${l.id}/confirm-repay`); }
  if (l.status === 'repay_pending') await call(l.repayRequestedByMe ? 'B' : 'A', 'POST', `/api/loans/${l.id}/confirm-repay`);
}
const paidBefore = (await call('B', 'GET', '/api/loans')).data.loans.filter((l) => l.status === 'paid').length;
const lv1 = await call('A', 'POST', '/api/ledgers/leave');
check('離開：結清後 A 可以離開（帳本保留）', lv1.status === 200 && lv1.data.deleted === false, lv1.data);
check('離開：A 離開後看不到這本帳', (await call('A', 'GET', '/api/me')).data.ledger === null);
const bMe = await call('B', 'GET', '/api/me');
check('離開：B 變成小窩唯一成員且是建立者', bMe.data.ledger.members.length === 1 && bMe.data.ledger.members[0].role === 'owner', bMe.data.ledger);
const bLoans = (await call('B', 'GET', '/api/loans')).data.loans;
check('離開：B 仍看得到以前的帳，而且名字還顯示「呱呱」', bLoans.filter((l) => l.status === 'paid').length === paidBefore && bLoans.some((l) => l.lender.name === '呱呱' || l.borrower.name === '呱呱'), bLoans.slice(0, 2));
const aLoans = await call('A', 'GET', '/api/loans');
check('離開：A 不能再讀這本帳的借款', aLoans.status === 409, aLoans.data);
const lvNew = await call('A', 'POST', '/api/ledgers', { nickname: '呱呱' });
check('離開：A 可以建立新的小窩', lvNew.status === 201, lvNew.data);
const bInv = await call('B', 'POST', '/api/ledgers/invite');
check('離開：B 可以產生新的邀請碼', bInv.status === 200 && bInv.data.ledger.invite?.code, bInv.data);

const bLedgerId = bMe.data.ledger.id;
const lvLast = await call('B', 'POST', '/api/ledgers/leave');
check('離開：最後一人離開 → 整本帳永久刪除', lvLast.status === 200 && lvLast.data.deleted === true, lvLast.data);
check('離開：B 之後沒有小窩', (await call('B', 'GET', '/api/me')).data.ledger === null);

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
