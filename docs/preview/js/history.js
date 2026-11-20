// 📊 歷史紀錄頁（H5）
// 規則：只算「已還」紀錄；花費算給實際還款人；月份依借款日期；「未指定」計入總花費並單獨顯示。
// H6 會在這裡加上圓餅圖、未指定補填、分類規則管理。

import { api } from './api.js';
import { esc, money } from './ui.js';

// 分類顏色：青蛙綠、綿羊奶油、木頭色系；「其他」固定灰色
const PALETTE = ['#8bc34a', '#f4b860', '#e88d67', '#7cb8c9', '#b48ead', '#d9a066', '#6fa36b', '#e5c07b', '#9fb4a0', '#c98bb9'];
export const OTHER_COLOR = '#b9b2a6';
export function colorFor(name, index) {
  return name === '其他' ? OTHER_COLOR : PALETTE[index % PALETTE.length];
}

const monthLabel = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return `${y} 年 ${mo} 月`;
};

export function mountHistory(container) {
  let periods = { months: [], years: [] };
  let type = 'month';      // 'month' 或 'year'
  let value = '';          // 例如 2026-11 或 2026
  let data = null;

  function optionsHtml() {
    const list = type === 'month' ? periods.months.map((m) => m.month) : periods.years;
    return list.map((v) => `<option value="${v}" ${v === value ? 'selected' : ''}>${type === 'month' ? monthLabel(v) : `${v} 年`}</option>`).join('');
  }

  function overviewHtml() {
    const people = data.people
      .map((p) => `<div><small>${esc(p.name)}${p.isMe ? '（我）' : ''}</small><b>${money(p.amount)}</b></div>`)
      .join('');
    const unspec = data.unspecified.count
      ? `<div class="unspec"><small>未指定還款人（${data.unspecified.count} 筆）</small><b>${money(data.unspecified.amount)}</b></div>`
      : '';
    return `
      <section class="card">
        <h2>💸 ${type === 'month' ? monthLabel(value) : `${value} 年`}的花費</h2>
        <div class="net even hist-total">${money(data.total)}<small>共 ${data.count} 筆已還</small></div>
        <div class="sum-grid">${people}${unspec}</div>
        <p class="hint center-text">只計算「已還」的紀錄，花費算給實際還款的人</p>
      </section>`;
  }

  function categoriesHtml() {
    if (data.empty) {
      return `<section class="card center"><p class="empty-hist">尚無花費資料 🐸🐑</p><p class="hint">這段期間還沒有「已還」的紀錄</p></section>`;
    }
    const rows = data.categories
      .map((c, i) => `
        <li class="cat-row">
          <span class="dot" style="background:${colorFor(c.name, i)}"></span>
          <span class="cat-name">${esc(c.name)}</span>
          <span class="cat-count">${c.count} 筆</span>
          <span class="cat-amount">${money(c.amount)}</span>
          <span class="cat-pct">${c.percent}%</span>
          <span class="bar"><i style="width:${c.percent}%;background:${colorFor(c.name, i)}"></i></span>
        </li>`)
      .join('');
    return `<section class="card"><h2>🧺 各類花費</h2><ul class="cat-list">${rows}</ul></section>`;
  }

  function render() {
    if (!periods.months.length) {
      container.innerHTML = `
        <section class="card center"><h2>📊 歷史紀錄</h2><p class="empty-hist">尚無花費資料 🐸🐑</p>
        <p class="hint">記帳並完成還款後，這裡就會出現每個月的花費統計。</p></section>`;
      return;
    }
    container.innerHTML = `
      <section class="card">
        <div class="summary-head">
          <h2>📊 歷史紀錄</h2>
          <select id="hist-value" aria-label="選擇期間">${optionsHtml()}</select>
        </div>
        <div class="seg hist-type">
          <button type="button" data-type="month" class="${type === 'month' ? 'on' : ''}">月份</button>
          <button type="button" data-type="year" class="${type === 'year' ? 'on' : ''}">年份</button>
        </div>
      </section>
      ${data ? overviewHtml() + categoriesHtml() : '<section class="card center"><div class="bounce">🐸</div></section>'}`;

    container.querySelector('#hist-value').onchange = (e) => {
      value = e.target.value;
      load();
    };
    container.querySelectorAll('[data-type]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.type === type) return;
        type = b.dataset.type;
        value = type === 'month' ? periods.months[0].month : periods.years[0];
        load();
      };
    });
  }

  async function load() {
    data = null;
    render();
    try {
      data = await api(`/api/history?${type}=${encodeURIComponent(value)}`);
    } catch (err) {
      container.innerHTML = `<section class="card"><p class="hint">😿 ${esc(err.message)}</p></section>`;
      return;
    }
    render();
  }

  /** 每次切到歷史頁時呼叫：重新抓期間列表（保留目前選的期間，若還存在） */
  async function refresh() {
    try {
      periods = await api('/api/history/periods');
    } catch (err) {
      container.innerHTML = `<section class="card"><p class="hint">😿 ${esc(err.message)}</p></section>`;
      return;
    }
    if (!periods.months.length) {
      data = null;
      return render();
    }
    const list = type === 'month' ? periods.months.map((m) => m.month) : periods.years;
    if (!list.includes(value)) value = list[0];
    await load();
  }

  return { refresh };
}
