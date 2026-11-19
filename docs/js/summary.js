// 統整卡片：只算「已同意且未還」的帳，顯示雙方各欠多少與最後誰該給誰
// 可選「全部」或指定月份（依借款日期）

import { api } from './api.js';
import { esc, money } from './ui.js';

const monthLabel = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return `${y} 年 ${mo} 月`;
};

export function mountSummary(container) {
  let month = ''; // '' 代表全部

  function render(s) {
    const options = ['<option value="">全部</option>']
      .concat(s.months.map((m) => `<option value="${m}" ${m === month ? 'selected' : ''}>${monthLabel(m)}</option>`))
      .join('');

    const headline = s.net
      ? `<div class="net ${s.net.toMe ? 'to-me' : 'from-me'}">
           <span class="who">${esc(s.net.from)}</span> 要給 <span class="who">${esc(s.net.to)}</span>
           <strong>${money(s.net.amount)}</strong>
         </div>`
      : `<div class="net even">${s.count ? '兩不相欠 🎉' : '目前沒有未還的帳 🐸🐑'}</div>`;

    container.innerHTML = `
      <section class="card summary">
        <div class="summary-head">
          <h2>🧮 統整</h2>
          <select id="sum-month" aria-label="選擇月份">${options}</select>
        </div>
        ${headline}
        <div class="sum-grid">
          <div><small>${esc(s.me.name)}（我）欠</small><b>${money(s.me.owes)}</b></div>
          <div><small>${esc(s.partner.name)} 欠</small><b>${money(s.partner.owes)}</b></div>
        </div>
        <p class="hint center-text">
          只計算已同意、還沒還的 ${s.count} 筆${s.repayPendingCount ? `（含 ${s.repayPendingCount} 筆已還待確認）` : ''}
        </p>
      </section>`;
    container.querySelector('#sum-month').onchange = (e) => {
      month = e.target.value;
      refresh();
    };
  }

  async function refresh() {
    try {
      const s = await api(`/api/summary${month ? `?month=${month}` : ''}`);
      // 選的月份如果已經不存在（例如紀錄被刪光），自動回到「全部」
      if (month && !s.months.includes(month)) {
        month = '';
        return refresh();
      }
      render(s);
    } catch (err) {
      container.innerHTML = `<section class="card"><p class="hint">😿 統整讀取失敗：${esc(err.message)}</p></section>`;
    }
  }

  refresh();
  return { refresh };
}
