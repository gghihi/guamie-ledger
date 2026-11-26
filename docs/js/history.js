// 📊 歷史紀錄頁
// H5：期間選擇、花費總覽、分類列表
// H6：項目圓餅圖（點選區塊看金額與筆數）、未指定還款人補填（二次確認）、分類規則管理
// 規則：算「已還」的借款＋「直接記帳」的花費；借款算給實際還款人、直接記帳算給付錢的人；
//       月份依借款／記帳日期；「未指定」計入總花費並單獨顯示。

import { api } from './api.js';
import { esc, money, toast, confirmDialog, openModal, withBusy, prettyDate } from './ui.js';

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

// ───────── 圓餅圖（SVG，自己畫，不用外部套件） ─────────

function arcPath(cx, cy, r, start, end) {
  const pt = (a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const [x1, y1] = pt(start);
  const [x2, y2] = pt(end);
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
}

function pieSvg(categories, total, selected) {
  const R = 90;
  if (categories.length === 1) {
    const c = categories[0];
    return `<svg viewBox="0 0 200 200" class="pie" role="img" aria-label="項目花費圓餅圖">
      <circle cx="100" cy="100" r="${R}" fill="${colorFor(c.name, 0)}" data-slice="0" class="slice on"><title>${esc(c.name)} 100%</title></circle>
      <circle cx="100" cy="100" r="44" fill="var(--sheep)"/></svg>`;
  }
  let angle = 0;
  const slices = categories.map((c, i) => {
    const sweep = (c.amount / total) * Math.PI * 2;
    const d = arcPath(100, 100, R, angle, angle + sweep);
    angle += sweep;
    return `<path d="${d}" fill="${colorFor(c.name, i)}" data-slice="${i}" class="slice ${selected === i ? 'on' : ''}" stroke="var(--sheep)" stroke-width="2"><title>${esc(c.name)} ${c.percent}%</title></path>`;
  });
  // 中間挖空成甜甜圈，看起來比較可愛
  return `<svg viewBox="0 0 200 200" class="pie" role="img" aria-label="項目花費圓餅圖">${slices.join('')}<circle cx="100" cy="100" r="44" fill="var(--sheep)"/></svg>`;
}

export function mountHistory(container) {
  let periods = { months: [], years: [] };
  let type = 'month';      // 'month' 或 'year'
  let value = '';          // 例如 2026-11 或 2026
  let data = null;
  let unspecified = [];
  let selected = null;     // 圓餅圖點選的分類索引

  const periodLabel = () => (type === 'month' ? monthLabel(value) : `${value} 年`);

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
        <h2>💸 ${periodLabel()}的花費</h2>
        <div class="net even hist-total">${money(data.total)}<small>共 ${data.count} 筆${data.expenseCount ? `（已還 ${data.loanCount}・直接記帳 ${data.expenseCount}）` : '已還'}</small></div>
        <div class="sum-grid">${people}${unspec}</div>
        <p class="hint center-text">計算「已還」的借款和「直接記帳」，花費算給實際付錢的人</p>
      </section>`;
  }

  function detailHtml() {
    if (selected === null || !data.categories[selected]) return '<p class="hint center-text pie-detail">點圓餅圖或下方分類，看詳細金額與筆數</p>';
    const c = data.categories[selected];
    return `<p class="pie-detail on"><span class="dot" style="background:${colorFor(c.name, selected)}"></span><b>${esc(c.name)}</b>：${money(c.amount)}・${c.count} 筆・${c.percent}%</p>`;
  }

  function categoriesHtml() {
    if (data.empty) {
      return `<section class="card center"><h2>🥧 項目花費</h2><p class="empty-hist">尚無花費資料 🐸🐑</p><p class="hint">這段期間還沒有「已還」或「直接記帳」的紀錄</p></section>`;
    }
    const rows = data.categories
      .map((c, i) => `
        <li class="cat-row ${selected === i ? 'on' : ''}" data-slice="${i}" role="button" tabindex="0">
          <span class="dot" style="background:${colorFor(c.name, i)}"></span>
          <span class="cat-name">${esc(c.name)}</span>
          <span class="cat-count">${c.count} 筆</span>
          <span class="cat-amount">${money(c.amount)}</span>
          <span class="cat-pct">${c.percent}%</span>
          <span class="bar"><i style="width:${c.percent}%;background:${colorFor(c.name, i)}"></i></span>
        </li>`)
      .join('');
    return `
      <section class="card">
        <h2>🥧 ${periodLabel()}的項目花費</h2>
        <div class="pie-wrap">${pieSvg(data.categories, data.total, selected)}</div>
        <div id="pie-detail">${detailHtml()}</div>
        <ul class="cat-list">${rows}</ul>
      </section>`;
  }

  function unspecifiedHtml() {
    if (!unspecified.length) return '';
    const rows = unspecified
      .map((l) => `
        <li class="loan">
          <div class="loan-body">
            <div class="loan-main"><strong>${esc(l.item)}</strong><small>${prettyDate(l.date)}・${esc(l.borrower.name)} 欠 ${esc(l.lender.name)}<span class="cat-chip">${esc(l.category)}</span></small></div>
            <div class="loan-side"><span class="amount">${money(l.amount)}</span></div>
          </div>
          <div class="loan-actions"><button class="btn tiny" data-fill="${l.id}">補填還款人</button></div>
        </li>`)
      .join('');
    return `
      <section class="card">
        <h2>❓ 未指定還款人</h2>
        <p class="hint">這些是舊的已還紀錄，補填還款人後，花費才會算到那個人身上。</p>
        <ul class="loans">${rows}</ul>
      </section>`;
  }

  function render() {
    if (!periods.months.length) {
      container.innerHTML = `
        <section class="card center"><h2>📊 歷史紀錄</h2><p class="empty-hist">尚無花費資料 🐸🐑</p>
        <p class="hint">記帳並完成還款後，這裡就會出現每個月的花費統計。</p>
        <button class="btn ghost" data-rules>⚙️ 分類規則</button></section>`;
      container.querySelector('[data-rules]').onclick = openRules;
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
      ${data ? overviewHtml() + categoriesHtml() + unspecifiedHtml() : '<section class="card center"><div class="bounce">🐸</div></section>'}
      <button class="btn ghost rules-btn" data-rules>⚙️ 分類規則</button>`;

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
    // 圓餅圖與分類列表互相對應：點哪一個都會標示同一類（F14）
    container.querySelectorAll('[data-slice]').forEach((el) => {
      const pick = () => {
        const i = Number(el.dataset.slice);
        selected = selected === i ? null : i;
        container.querySelectorAll('[data-slice]').forEach((x) => x.classList.toggle('on', Number(x.dataset.slice) === selected));
        container.querySelector('#pie-detail').innerHTML = detailHtml();
      };
      el.addEventListener('click', pick);
      el.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()));
    });
    container.querySelectorAll('[data-fill]').forEach((b) => {
      b.onclick = () => fillRepayer(unspecified.find((l) => l.id === b.dataset.fill));
    });
    container.querySelector('[data-rules]').onclick = openRules;
  }

  // ───────── 未指定還款人：補填（選人 → 再確認一次 → 送出） ─────────

  function fillRepayer(l) {
    let pick = null;
    const { el, close } = openModal(`
      <h2>補填還款人</h2>
      <p>${esc(l.item)} ${money(l.amount)}（${prettyDate(l.date)}）</p>
      <div class="field">這筆是誰還的錢？
        <div class="seg">
          <button type="button" data-p="${esc(l.borrower.id)}">${esc(l.borrower.name)}<small>欠錢的人</small></button>
          <button type="button" data-p="${esc(l.lender.id)}">${esc(l.lender.name)}<small>借出的人自己負擔</small></button>
        </div>
      </div>
      <div class="row">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn" id="fill-next" disabled>下一步</button>
      </div>`);
    el.querySelectorAll('[data-p]').forEach((b) => {
      b.onclick = () => {
        pick = b.dataset.p;
        el.querySelectorAll('[data-p]').forEach((x) => x.classList.toggle('on', x === b));
        el.querySelector('#fill-next').disabled = false;
      };
    });
    el.querySelector('#fill-next').onclick = async () => {
      const who = pick === l.borrower.id ? l.borrower.name : l.lender.name;
      close();
      // 第二次確認（F12）
      const ok = await confirmDialog({
        title: '確定要補填嗎？',
        message: `把「${l.item} ${money(l.amount)}」的還款人設為「${who}」？\n\n確認後，這筆花費會算到 ${who} 身上。`,
        okText: '確定補填',
      });
      if (!ok) return;
      try {
        await api(`/api/loans/${l.id}/repayer`, { method: 'POST', body: { userId: pick } });
        toast(`已補填：${who}`, 'ok');
        await load();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }

  // ───────── 分類規則管理（F6、F9） ─────────

  async function openRules() {
    let rules;
    try {
      rules = (await api('/api/categories')).categories.filter((c) => !c.isOther).map((c) => ({ name: c.name, keywords: c.keywords.join('、') }));
    } catch (err) {
      return toast(err.message, 'error');
    }
    const { el, close } = openModal('<div id="rules-body"></div>');
    el.classList.add('rules-modal');

    const draw = () => {
      el.querySelector('#rules-body').innerHTML = `
        <div class="settings-head"><h2>⚙️ 分類規則</h2><button class="btn tiny ghost" data-close>✕ 關閉</button></div>
        <p class="hint">項目名稱「包含」關鍵字就歸入該類；同時符合多類時，以<b>排在上面</b>的為準。關鍵字用「、」分開。</p>
        <ol class="rule-list">
          ${rules.map((r, i) => `
            <li class="rule-card">
              <div class="rule-head">
                <span class="dot" style="background:${colorFor(r.name, i)}"></span>
                <input class="rule-name" data-i="${i}" maxlength="12" value="${esc(r.name)}" aria-label="分類名稱" />
                <button type="button" class="btn tiny ghost" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="往上移">▲</button>
                <button type="button" class="btn tiny ghost" data-down="${i}" ${i === rules.length - 1 ? 'disabled' : ''} aria-label="往下移">▼</button>
                <button type="button" class="btn tiny ghost danger" data-del="${i}" aria-label="刪除分類">🗑</button>
              </div>
              <textarea class="rule-kw" data-i="${i}" rows="2" placeholder="例如：早餐、午餐、便當">${esc(r.keywords)}</textarea>
            </li>`).join('')}
          <li class="rule-card other"><div class="rule-head"><span class="dot" style="background:${OTHER_COLOR}"></span><b>其他</b></div><small class="hint">對應不到任何關鍵字的項目，固定排最後</small></li>
        </ol>
        <button type="button" class="btn ghost" id="rule-add">＋ 新增分類</button>
        <button type="button" class="btn" id="rule-save">儲存規則</button>
        <p class="hint center-text">儲存後只影響「之後新增」的紀錄，歷史數字不會變。</p>
        <button type="button" class="btn ghost danger" id="rule-recalc">用目前規則重新分類全部紀錄</button>`;

      // 先把輸入框的內容存回 rules，再處理按鈕（避免重畫時打的字不見）
      const sync = () => {
        el.querySelectorAll('.rule-name').forEach((x) => { rules[x.dataset.i].name = x.value; });
        el.querySelectorAll('.rule-kw').forEach((x) => { rules[x.dataset.i].keywords = x.value; });
      };
      el.querySelectorAll('[data-up]').forEach((b) => { b.onclick = () => { sync(); const i = +b.dataset.up; [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]]; draw(); }; });
      el.querySelectorAll('[data-down]').forEach((b) => { b.onclick = () => { sync(); const i = +b.dataset.down; [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]]; draw(); }; });
      el.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = async () => {
          sync();
          const r = rules[+b.dataset.del];
          const ok = await confirmDialog({ title: `刪除「${r.name || '未命名'}」？`, message: '刪除後，之後新增的紀錄不會再歸到這一類（已存在的紀錄不受影響）。記得按「儲存規則」才會生效。', okText: '刪除' });
          if (!ok) return;
          rules.splice(+b.dataset.del, 1);
          draw();
        };
      });
      el.querySelector('#rule-add').onclick = () => {
        sync();
        rules.push({ name: '', keywords: '' });
        draw();
        el.querySelectorAll('.rule-name')[rules.length - 1]?.focus();
      };
      el.querySelector('#rule-save').onclick = (e) =>
        withBusy(e.currentTarget, async () => {
          sync();
          const res = await api('/api/categories', { method: 'PUT', body: { categories: rules.map((r) => ({ name: r.name, keywords: r.keywords })) } });
          rules = res.categories.filter((c) => !c.isOther).map((c) => ({ name: c.name, keywords: c.keywords.join('、') }));
          toast('規則已儲存，之後新增的紀錄會用新規則分類', 'ok');
          draw();
        });
      el.querySelector('#rule-recalc').onclick = async () => {
        sync();
        const ok = await confirmDialog({
          title: '重新分類全部紀錄？',
          message: '會用「目前已儲存」的規則，重新分類這本帳的所有紀錄。\n\n⚠️ 歷史月份的分類數字可能會改變。\n（還沒按「儲存規則」的修改不會被使用）',
          okText: '重新分類',
        });
        if (!ok) return;
        try {
          const r = await api('/api/categories/recalculate', { method: 'POST' });
          toast(`完成！${r.total} 筆中有 ${r.updated} 筆改了分類`, 'ok');
          close();
          await load();
        } catch (err) {
          toast(err.message, 'error');
        }
      };
    };
    draw();
  }

  // ───────── 讀取資料 ─────────

  async function load() {
    data = null;
    selected = null;
    render();
    try {
      [data, { loans: unspecified }] = await Promise.all([
        api(`/api/history?${type}=${encodeURIComponent(value)}`),
        api(`/api/history/unspecified?${type}=${encodeURIComponent(value)}`),
      ]);
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
