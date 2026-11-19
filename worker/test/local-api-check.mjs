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
