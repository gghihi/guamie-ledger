// 計算機（放在統整下面，可收合）：一般 ＋−×÷，加上「平分 ÷2」，
// 算好的結果可以按「帶入記帳金額」直接填進下面的記帳卡片。

import { toast } from './ui.js';
import { playSound } from './sound.js';

const OPS = ['+', '−', '×', '÷'];

/** 把小數誤差修掉（例如 0.1+0.2 會變 0.30000000000000004） */
const tidy = (n) => Math.round(n * 1e8) / 1e8;

/** 數字顯示成有千分位的樣子，例如 12345.5 → 12,345.5 */
const show = (n) => n.toLocaleString('zh-TW', { maximumFractionDigits: 8 });

/**
 * 算出算式的結果，例如 "120+85×2" → 290（先乘除、後加減）。
 * 算式不完整時（例如結尾是 +）會先忽略結尾的符號。
 * 回傳 { value } 或 { error }。
 */
export function evaluate(expr) {
  const tokens = expr.match(/\d+\.?\d*|\.\d+|[+−×÷]/g) || [];
  while (tokens.length && OPS.includes(tokens[tokens.length - 1])) tokens.pop();
  // 開頭的負號（例如 −50+80）併進第一個數字
  if (tokens[0] === '−') tokens.splice(0, 2, String(-Number(tokens[1] ?? 0)));
  if (!tokens.length) return { value: 0 };

  // 先把乘除算掉，剩下的再從左到右加減
  const terms = [Number(tokens[0])];
  const signs = [];
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i];
    const num = Number(tokens[i + 1]);
    if (op === '×') terms[terms.length - 1] *= num;
    else if (op === '÷') {
      if (num === 0) return { error: '不能除以 0 喔' };
      terms[terms.length - 1] /= num;
    } else {
      signs.push(op);
      terms.push(num);
    }
  }
  let value = terms[0];
  signs.forEach((op, i) => {
    value = op === '+' ? value + terms[i + 1] : value - terms[i + 1];
  });
  return { value: tidy(value) };
}

/**
 * 在 container 放入計算機。
 * onUse(amount)：按「帶入記帳金額」時呼叫（沒有給就不顯示那個按鈕）。
 */
export function mountCalculator(container, { onUse } = {}) {
  let expr = '';        // 正在輸入的算式，例如 "120+85×2"
  let lastLine = '';    // 按「＝」後，上一行顯示剛剛算的式子
  let justDone = false; // 剛按完「＝」：接著按數字會重新開始，按符號會接著算

  const keys = [
    ['C', 'clear', '清除'], ['⌫', 'back', '刪一格'], ['平分', 'half', '平分（除以 2）'], ['÷', 'op'],
    ['7'], ['8'], ['9'], ['×', 'op'],
    ['4'], ['5'], ['6'], ['−', 'op'],
    ['1'], ['2'], ['3'], ['+', 'op'],
    ['0', 'num wide'], ['.', 'dot', '小數點'], ['=', 'eq', '等於'],
  ];

  container.innerHTML = `
    <details class="card calc">
      <summary><h2>🔢 計算機</h2><span class="hint">點一下打開</span></summary>
      <div class="calc-screen" aria-live="polite">
        <div class="calc-line" id="calc-line"></div>
        <div class="calc-expr" id="calc-expr">0</div>
        <div class="calc-result" id="calc-result"></div>
      </div>
      <div class="calc-keys">
        ${keys
          .map(([label, kind = 'num', aria]) => `<button type="button" class="k ${kind}" data-k="${label}" ${aria ? `aria-label="${aria}"` : ''}>${label === '平分' ? '平分<small>÷2</small>' : label}</button>`)
          .join('')}
      </div>
      ${onUse ? '<button type="button" class="btn" id="calc-use">📥 帶入記帳金額</button>' : ''}
    </details>`;

  const details = container.querySelector('details');
  const lineEl = container.querySelector('#calc-line');
  const exprEl = container.querySelector('#calc-expr');
  const resultEl = container.querySelector('#calc-result');

  details.addEventListener('toggle', () => {
    details.querySelector('summary .hint').textContent = details.open ? '點一下收起來' : '點一下打開';
  });

  /** 算式畫面：數字加上千分位，比較好讀 */
  const pretty = (s) => s.replace(/\d+\.?\d*|\.\d+/g, (n) => (n.includes('.') ? n : Number(n).toLocaleString('zh-TW')));

  function paint() {
    lineEl.textContent = lastLine;
    exprEl.textContent = expr ? pretty(expr) : '0';
    const r = evaluate(expr);
    // 有運算符號才在下面預覽結果；剛按完＝就不重複顯示
    const hasOp = /[+−×÷]/.test(expr.slice(1));
    resultEl.textContent = r.error ? r.error : hasOp && !justDone ? `= ${show(r.value)}` : '';
    resultEl.classList.toggle('err', Boolean(r.error));
  }

  /** 目前這一段數字（最後一個符號後面的部分） */
  const currentNumber = () => expr.split(/[+−×÷]/).pop();

  function press(k) {
    if (k === 'C') {
      expr = '';
      lastLine = '';
      justDone = false;
    } else if (k === '⌫') {
      expr = justDone ? '' : expr.slice(0, -1);
      justDone = false;
    } else if (/\d/.test(k)) {
      if (justDone) {
        expr = '';
        lastLine = '';
      }
      justDone = false;
      const cur = currentNumber();
      if (cur === '0') expr = expr.slice(0, -1); // 避免出現 007
      if (cur.replace('.', '').length >= 12) return toast('數字太長了', 'info');
      expr += k;
    } else if (k === '.') {
      if (justDone) {
        expr = '';
        lastLine = '';
      }
      justDone = false;
      const cur = currentNumber();
      if (cur.includes('.')) return;
      expr += cur === '' ? '0.' : '.';
    } else if (OPS.includes(k)) {
      justDone = false;
      if (!expr) {
        if (k !== '−') return; // 開頭只能打負號
        expr = '−';
      } else if (OPS.includes(expr.slice(-1))) {
        if (expr.length === 1) return;
        expr = expr.slice(0, -1) + k; // 連按兩個符號：換成後按的那個
      } else {
        expr += k;
      }
    } else if (k === '=' || k === '平分') {
      const r = evaluate(expr);
      if (r.error) return toast(r.error, 'error');
      if (k === '平分') {
        const half = tidy(r.value / 2);
        lastLine = `${show(r.value)} ÷ 2 =`;
        expr = String(half);
      } else {
        if (!/[+−×÷]/.test(expr.slice(1))) return; // 沒有要算的
        lastLine = `${pretty(expr)} =`;
        expr = String(r.value);
      }
      if (expr.startsWith('-')) expr = `−${expr.slice(1)}`;
      justDone = true;
    }
    paint();
  }

  container.querySelectorAll('[data-k]').forEach((b) => {
    b.onclick = () => {
      playSound('tap');
      press(b.dataset.k);
    };
  });

  container.querySelector('#calc-use')?.addEventListener('click', () => {
    const r = evaluate(expr);
    if (r.error) return toast(r.error, 'error');
    const amount = Math.round(r.value);
    if (!(amount > 0)) return toast('金額要大於 0 才能帶入喔', 'error');
    if (amount !== r.value) toast(`記帳金額只能是整數，已四捨五入成 ${show(amount)}`, 'info');
    onUse(amount);
  });

  paint();
}
