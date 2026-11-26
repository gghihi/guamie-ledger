// 🧾 記帳紀錄：直接記帳（花費）的清單，可選月份、看合計、修改、刪除
// 和借還款清單分開；這些花費不算進統整，會算進歷史紀錄（算給付錢的人）。

import { api } from './api.js';
import { esc, money, prettyDate, toast, confirmDialog, openModal, withBusy, todayTaipei } from './ui.js';
import { playSound } from './sound.js';

const PAGE = 20; // 一次顯示幾筆，太多時按「顯示更多」

const monthLabel = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return `${y} 年 ${mo} 月`;
};

/** ctx = { partner: { nickname } } */
export function mountExpenseList(container, ctx) {
  const partner = ctx.partner.nickname;
  let expenses = [];
  let month = ''; // '' 代表全部
  let shown = PAGE;
  let lastSnapshot = '';
  let loaded = false;

  const describe = (x) => `${x.item} ${money(x.amount)}（${x.payer.isMe ? '我' : x.payer.name}付的，${prettyDate(x.date)}）`;

  function render() {
    const months = [...new Set(expenses.map((x) => x.date.slice(0, 7)))];
    if (month && !months.includes(month)) month = '';
    const rows = expenses.filter((x) => !month || x.date.startsWith(month));
    const total = rows.reduce((s, x) => s + x.amount, 0);
    const options = ['<option value="">全部</option>']
      .concat(months.map((m) => `<option value="${m}" ${m === month ? 'selected' : ''}>${monthLabel(m)}</option>`))
      .join('');

    container.innerHTML = `
      <section class="card expenses">
        <div class="summary-head">
          <h2>🧾 記帳紀錄</h2>
          ${expenses.length ? `<select id="exp-month" aria-label="選擇月份">${options}</select>` : ''}
        </div>
        ${rows.length
          ? `<p class="exp-total">合計 <strong>${money(total)}</strong><small>（${rows.length} 筆）</small></p>
             <ul class="loans">${rows.slice(0, shown).map(row).join('')}</ul>
             ${rows.length > shown ? `<button class="btn ghost" data-act="more">顯示更多（還有 ${rows.length - shown} 筆）</button>` : ''}`
          : '<p class="hint center-text empty">還沒有直接記帳的紀錄 🐑<br>在上面「記一筆」切到「🧾 直接記帳」就能記</p>'}
      </section>`;
    container.querySelector('#exp-month')?.addEventListener('change', (e) => {
      month = e.target.value;
      shown = PAGE;
      render();
    });
  }

  function row(x) {
    return `
      <li class="loan ${x.payer.isMe ? 'i-owe' : 'owe-me'}">
        <div class="loan-body">
          <div class="loan-main">
            <strong>${esc(x.item)}</strong>
            <small>${prettyDate(x.date)}・${x.payer.isMe ? '我' : esc(x.payer.name)}付的<span class="cat-chip">${esc(x.category)}</span></small>
          </div>
          <div class="loan-side"><span class="amount">${money(x.amount)}</span></div>
        </div>
        <div class="loan-actions">
          <button class="btn tiny ghost" data-act="edit" data-id="${x.id}">修改</button>
          <button class="btn tiny ghost danger" data-act="delete" data-id="${x.id}">刪除</button>
        </div>
      </li>`;
  }

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'more') {
      shown += PAGE;
      return render();
    }
    const x = expenses.find((v) => v.id === btn.dataset.id);
    if (!x) return;
    if (btn.dataset.act === 'delete') await remove(x, btn);
    if (btn.dataset.act === 'edit') edit(x);
  });

  async function remove(x, btn) {
    const ok = await confirmDialog({ title: '刪除這筆嗎？', message: `${describe(x)}\n\n刪除後無法復原。`, okText: '刪除' });
    if (!ok) return;
    await withBusy(btn, async () => {
      await api(`/api/expenses/${x.id}`, { method: 'DELETE' });
      toast('已刪除', 'ok');
      playSound('soft');
      await refresh();
    });
  }

  function edit(x) {
    const d = { payer: x.payer.isMe ? 'me' : 'partner' };
    const { el, close } = openModal(`
      <h2>修改這筆</h2>
      <label class="field">金額<input type="number" inputmode="numeric" min="1" step="1" id="x-amount" value="${x.amount}" /></label>
      <div class="field">誰付的
        <div class="seg">
          <button type="button" data-p="me">我付的</button>
          <button type="button" data-p="partner">${esc(partner)}付的</button>
        </div>
      </div>
      <label class="field">項目<input id="x-item" maxlength="30" value="${esc(x.item)}" /></label>
      <label class="field">日期<input type="date" id="x-date" max="${todayTaipei()}" value="${x.date}" /></label>
      <div class="row">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn" id="x-save">儲存</button>
      </div>`);
    const paint = () => el.querySelectorAll('[data-p]').forEach((b) => b.classList.toggle('on', b.dataset.p === d.payer));
    paint();
    el.querySelectorAll('[data-p]').forEach((b) => {
      b.onclick = () => {
        d.payer = b.dataset.p;
        paint();
      };
    });
    el.querySelector('#x-save').onclick = (e) =>
      withBusy(e.currentTarget, async () => {
        const body = {
          amount: Number(el.querySelector('#x-amount').value),
          payer: d.payer,
          item: el.querySelector('#x-item').value.trim(),
          date: el.querySelector('#x-date').value,
        };
        if (!(Number.isInteger(body.amount) && body.amount > 0)) throw new Error('金額要是大於 0 的整數');
        if (!body.item) throw new Error('項目不能空白');
        if (!body.date) throw new Error('請選日期');
        await api(`/api/expenses/${x.id}`, { method: 'PUT', body });
        close();
        toast('已修改', 'ok');
        playSound('send');
        await refresh();
      });
  }

  /**
   * 重新抓資料。quiet = true 時是背景同步：抓不到不顯示錯誤，資料沒變就不重畫。
   * 回傳資料有沒有改變。
   */
  async function refresh({ quiet = false } = {}) {
    let fresh;
    try {
      fresh = (await api('/api/expenses')).expenses;
    } catch (err) {
      if (!quiet) container.innerHTML = `<section class="card"><p class="hint">😿 記帳紀錄讀取失敗：${esc(err.message)}</p></section>`;
      return false;
    }
    const snapshot = JSON.stringify(fresh);
    const changed = snapshot !== lastSnapshot;
    lastSnapshot = snapshot;
    expenses = fresh;
    if (!changed && loaded) return false;
    render();
    loaded = true;
    return changed;
  }

  refresh();
  return { refresh };
}
