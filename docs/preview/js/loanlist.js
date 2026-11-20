// 借款清單：分成「待確認」「未還」「已還」三區
// 第 7 階段：同意、全部同意、否定、撤回、修改重送、刪除、查看狀態紀錄

import { api } from './api.js';
import { esc, money, prettyDate, toast, confirmDialog, openModal, withBusy, todayTaipei } from './ui.js';

const TABS = [
  { key: 'pending', label: '待確認', statuses: ['pending', 'rejected'] },
  { key: 'unpaid', label: '未還', statuses: ['unpaid', 'repay_pending'] },
  { key: 'paid', label: '已還', statuses: ['paid'] },
];

const STATUS_NAME = { pending: '待確認', unpaid: '未還', repay_pending: '已還待確認', paid: '已還', rejected: '被否定' };
const ACTION_NAME = {
  create: '記了這筆帳', approve: '同意了', reject: '否定了', resubmit: '修改後重送',
  withdraw: '撤回了', request_repay: '標記已還款', confirm_repay: '確認已還款',
  cancel_repay: '取消了還款標記', decline_repay: '表示還沒收到還款', delete: '刪除了',
};

/** ctx = { partner: { nickname } } */
export function mountLoanList(container, ctx) {
  const partner = ctx.partner.nickname;
  let loans = [];
  let tab = 'pending';

  const describe = (l) => `${l.item} ${money(l.amount)}（${l.borrower.name} 欠 ${l.lender.name}，${prettyDate(l.date)}）`;

  function statusTag(l) {
    switch (l.status) {
      case 'pending': return l.createdByMe ? '<span class="tag wait">等對方確認</span>' : '<span class="tag todo">等你確認</span>';
      case 'rejected': return '<span class="tag no">被否定</span>';
      case 'repay_pending': return l.repayRequestedByMe ? '<span class="tag wait">已還待確認</span>' : '<span class="tag todo">請確認還款</span>';
      case 'paid': return '<span class="tag">已還</span>';
      default: return '';
    }
  }

  /** 依照狀態與身分，決定這筆可以按哪些按鈕 */
  function actions(l) {
    if (l.status === 'pending' && !l.createdByMe) {
      return `<button class="btn tiny" data-act="approve" data-id="${l.id}">同意</button>
              <button class="btn tiny ghost" data-act="reject" data-id="${l.id}">否定</button>`;
    }
    if (l.status === 'pending' && l.createdByMe) {
      return `<button class="btn tiny ghost" data-act="withdraw" data-id="${l.id}">撤回</button>`;
    }
    if (l.status === 'rejected' && l.createdByMe) {
      return `<button class="btn tiny" data-act="edit" data-id="${l.id}">修改重送</button>
              <button class="btn tiny ghost danger" data-act="delete" data-id="${l.id}">刪除</button>`;
    }
    if (l.status === 'rejected') return `<small class="hint">已否定，等${esc(partner)}處理</small>`;
    if (l.status === 'unpaid') {
      return `<button class="btn tiny" data-act="repay" data-id="${l.id}">已還款</button>`;
    }
    if (l.status === 'repay_pending' && !l.repayRequestedByMe) {
      return `<button class="btn tiny" data-act="confirm-repay" data-id="${l.id}">確認已還</button>
              <button class="btn tiny ghost" data-act="decline-repay" data-id="${l.id}">還沒收到</button>`;
    }
    if (l.status === 'repay_pending') {
      return `<small class="hint">等${esc(partner)}確認</small>
              <button class="btn tiny ghost" data-act="cancel-repay" data-id="${l.id}">取消標記</button>`;
    }
    if (l.status === 'paid') {
      return `<button class="btn tiny ghost danger" data-act="delete" data-id="${l.id}">刪除</button>`;
    }
    return '';
  }

  function row(l) {
    return `
      <li class="loan ${l.borrower.isMe ? 'i-owe' : 'owe-me'}">
        <button class="loan-body" data-act="detail" data-id="${l.id}" aria-label="查看這筆的紀錄">
          <div class="loan-main">
            <strong>${esc(l.item)}</strong>
            <small>${prettyDate(l.date)}・${esc(l.borrower.name)} 欠 ${esc(l.lender.name)}<span class="cat-chip">${esc(l.category || '其他')}</span></small>
            ${l.status === 'paid' ? `<small class="payer">${l.repaidBy ? `💰 ${esc(l.repaidBy.name)} 還款` : '💰 還款人：未指定'}</small>` : ''}
            ${l.status === 'rejected' && l.rejectReason ? `<small class="reason">否定原因：${esc(l.rejectReason)}</small>` : ''}
          </div>
          <div class="loan-side">
            <span class="amount">${money(l.amount)}</span>
            ${statusTag(l)}
          </div>
        </button>
        ${actions(l) ? `<div class="loan-actions">${actions(l)}</div>` : ''}
      </li>`;
  }

  function render() {
    const current = TABS.find((t) => t.key === tab);
    const rows = loans.filter((l) => current.statuses.includes(l.status));
    const toApprove = loans.filter((l) => l.status === 'pending' && !l.createdByMe).length;
    container.innerHTML = `
      <section class="card">
        <div class="tabs" role="tablist">
          ${TABS.map((t) => {
            const n = loans.filter((l) => t.statuses.includes(l.status)).length;
            return `<button role="tab" data-tab="${t.key}" class="${t.key === tab ? 'on' : ''}">${t.label}<span class="count">${n}</span></button>`;
          }).join('')}
        </div>
        ${tab === 'pending' && toApprove > 1 ? `<button class="btn approve-all" data-act="approve-all">全部同意（${toApprove} 筆）</button>` : ''}
        ${rows.length ? `<ul class="loans">${rows.map(row).join('')}</ul>` : '<p class="hint center-text empty">這裡還沒有紀錄 🐑</p>'}
      </section>`;
  }

  // 所有按鈕共用一個點擊處理
  container.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      tab = tabBtn.dataset.tab;
      render();
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const loan = loans.find((l) => l.id === btn.dataset.id);
    const handlers = {
      approve, reject, withdraw, edit, delete: remove, detail, 'approve-all': approveAll,
      repay, 'confirm-repay': confirmRepay, 'cancel-repay': cancelRepay, 'decline-repay': declineRepay,
    };
    await handlers[btn.dataset.act]?.(loan, btn);
  });

  async function approve(l, btn) {
    const ok = await confirmDialog({ title: '同意這筆嗎？', message: `${describe(l)}\n\n同意後會變成「未還」，並算進統整。`, okText: '同意' });
    if (!ok) return;
    await withBusy(btn, async () => {
      await api(`/api/loans/${l.id}/approve`, { method: 'POST' });
      toast('已同意 🐸', 'ok');
      await refresh();
    });
  }

  async function approveAll(_l, btn) {
    const list = loans.filter((x) => x.status === 'pending' && !x.createdByMe);
    const total = list.reduce((s, x) => s + x.amount, 0);
    const ok = await confirmDialog({
      title: `全部同意 ${list.length} 筆？`,
      message: `${list.map((x) => `・${x.item} ${money(x.amount)}`).join('\n')}\n\n合計 ${money(total)}`,
      okText: '全部同意',
    });
    if (!ok) return;
    await withBusy(btn, async () => {
      const r = await api('/api/loans/approve-all', { method: 'POST' });
      toast(`已同意 ${r.approved} 筆`, 'ok');
      await refresh();
    });
  }

  function reject(l) {
    const { el, close } = openModal(`
      <h2>否定這筆？</h2>
      <p>${esc(describe(l))}</p>
      <label>原因（可不填）<input id="reason" maxlength="100" placeholder="例如：金額不對、我已經還了" /></label>
      <p class="hint">否定後會通知${esc(partner)}，他可以修改後重送或刪除。</p>
      <div class="row">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn danger-fill" id="do-reject">確認否定</button>
      </div>`);
    el.querySelector('#do-reject').onclick = (e) =>
      withBusy(e.currentTarget, async () => {
        await api(`/api/loans/${l.id}/reject`, { method: 'POST', body: { reason: el.querySelector('#reason').value.trim() } });
        close();
        toast('已否定，會通知對方', 'ok');
        await refresh();
      });
  }

  async function withdraw(l, btn) {
    const ok = await confirmDialog({ title: '撤回這筆嗎？', message: `${describe(l)}\n\n撤回後這筆會被移除。`, okText: '撤回' });
    if (!ok) return;
    await withBusy(btn, async () => {
      await api(`/api/loans/${l.id}/withdraw`, { method: 'POST' });
      toast('已撤回', 'ok');
      await refresh();
    });
  }

  /** 已還款：確認畫面裡多一個「誰還的錢？」（歷史紀錄的花費算給他），預設是欠錢的人 */
  function repay(l) {
    let repaidBy = l.borrower.id;
    const { el, close } = openModal(`
      <h2>這筆已經還了嗎？</h2>
      <p>${esc(describe(l))}</p>
      <div class="field">誰還的錢？<small class="hint">（歷史紀錄的花費會算給他）</small>
        <div class="seg">
          <button type="button" data-payer="${esc(l.borrower.id)}">${esc(l.borrower.name)}${l.borrower.isMe ? '（我）' : ''}<small>欠錢的人</small></button>
          <button type="button" data-payer="${esc(l.lender.id)}">${esc(l.lender.name)}${l.lender.isMe ? '（我）' : ''}<small>借出的人自己負擔</small></button>
        </div>
      </div>
      <p class="hint">標記後要等${esc(partner)}確認，才會移到「已還」。</p>
      <div class="row">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn" id="do-repay">已還款</button>
      </div>`);
    const paint = () => el.querySelectorAll('[data-payer]').forEach((b) => b.classList.toggle('on', b.dataset.payer === repaidBy));
    paint();
    el.querySelectorAll('[data-payer]').forEach((b) => {
      b.onclick = () => {
        repaidBy = b.dataset.payer;
        paint();
      };
    });
    el.querySelector('#do-repay').onclick = (e) =>
      withBusy(e.currentTarget, async () => {
        await api(`/api/loans/${l.id}/repay`, { method: 'POST', body: { repaidBy } });
        close();
        toast(`已標記，等${partner}確認`, 'ok');
        await refresh();
      });
  }

  async function confirmRepay(l, btn) {
    const ok = await confirmDialog({
      title: '確認已經還清了嗎？',
      message: `${describe(l)}\n\n確認後會移到「已還」，不再算進統整。`,
      okText: '確認已還',
    });
    if (!ok) return;
    await withBusy(btn, async () => {
      await api(`/api/loans/${l.id}/confirm-repay`, { method: 'POST' });
      toast('還款完成 🎉', 'ok');
      await refresh();
    });
  }

  async function cancelRepay(l, btn) {
    const ok = await confirmDialog({
      title: '取消還款標記？',
      message: `${describe(l)}\n\n這筆會回到「未還」。`,
      okText: '取消標記',
      cancelText: '先不要',
    });
    if (!ok) return;
    await withBusy(btn, async () => {
      await api(`/api/loans/${l.id}/cancel-repay`, { method: 'POST' });
      toast('已取消標記，回到未還', 'ok');
      await refresh();
    });
  }

  function declineRepay(l) {
    const { el, close } = openModal(`
      <h2>還沒收到這筆還款？</h2>
      <p>${esc(describe(l))}</p>
      <label>說明（可不填）<input id="decline-reason" maxlength="100" placeholder="例如：還沒收到轉帳" /></label>
      <p class="hint">這筆會回到「未還」，並通知${esc(partner)}。</p>
      <div class="row">
        <button class="btn ghost" data-close>先不要</button>
        <button class="btn danger-fill" id="do-decline">確認退回</button>
      </div>`);
    el.querySelector('#do-decline').onclick = (e) =>
      withBusy(e.currentTarget, async () => {
        await api(`/api/loans/${l.id}/decline-repay`, { method: 'POST', body: { reason: el.querySelector('#decline-reason').value.trim() } });
        close();
        toast('已退回，會通知對方', 'ok');
        await refresh();
      });
  }

  async function remove(l, btn) {
    const ok = await confirmDialog({ title: '刪除這筆嗎？', message: `${describe(l)}\n\n刪除後無法復原。`, okText: '刪除' });
    if (!ok) return;
    await withBusy(btn, async () => {
      await api(`/api/loans/${l.id}`, { method: 'DELETE' });
      toast('已刪除', 'ok');
      await refresh();
    });
  }

  function edit(l) {
    const draft = { amount: l.amount, direction: l.lender.isMe ? 'me_lent' : 'partner_lent', item: l.item, date: l.date };
    const { el, close } = openModal(`
      <h2>修改後重送</h2>
      ${l.rejectReason ? `<p class="reason">${esc(partner)}的否定原因：${esc(l.rejectReason)}</p>` : ''}
      <label class="field">金額<input type="number" inputmode="numeric" min="1" step="1" id="e-amount" value="${draft.amount}" /></label>
      <div class="field">誰欠誰
        <div class="seg">
          <button type="button" data-dir="me_lent">我借給${esc(partner)}<small>${esc(partner)}欠我</small></button>
          <button type="button" data-dir="partner_lent">${esc(partner)}借給我<small>我欠${esc(partner)}</small></button>
        </div>
      </div>
      <label class="field">項目<input id="e-item" maxlength="30" value="${esc(draft.item)}" /></label>
      <label class="field">日期<input type="date" id="e-date" max="${todayTaipei()}" value="${draft.date}" /></label>
      <div class="row">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn" id="do-resubmit">確認重送</button>
      </div>`);
    const paintDir = () => el.querySelectorAll('[data-dir]').forEach((b) => b.classList.toggle('on', b.dataset.dir === draft.direction));
    paintDir();
    el.querySelectorAll('[data-dir]').forEach((b) => {
      b.onclick = () => {
        draft.direction = b.dataset.dir;
        paintDir();
      };
    });
    el.querySelector('#do-resubmit').onclick = (e) =>
      withBusy(e.currentTarget, async () => {
        const body = {
          amount: Number(el.querySelector('#e-amount').value),
          direction: draft.direction,
          item: el.querySelector('#e-item').value.trim(),
          date: el.querySelector('#e-date').value,
        };
        if (!(Number.isInteger(body.amount) && body.amount > 0)) throw new Error('金額要是大於 0 的整數');
        if (!body.item) throw new Error('項目不能空白');
        if (!body.date) throw new Error('請選日期');
        await api(`/api/loans/${l.id}`, { method: 'PUT', body });
        close();
        toast(`已重送，等${partner}確認`, 'ok');
        await refresh();
      });
  }

  async function detail(l) {
    const { el } = openModal(`<h2>${esc(l.item)} ${money(l.amount)}</h2><p class="hint">讀取紀錄中…</p>`);
    try {
      const { events } = await api(`/api/loans/${l.id}/events`);
      el.innerHTML = `
        <h2>${esc(l.item)} ${money(l.amount)}</h2>
        <p>${esc(l.borrower.name)} 欠 ${esc(l.lender.name)}・${prettyDate(l.date)}・目前：<strong>${STATUS_NAME[l.status]}</strong></p>
        <h3>📜 狀態紀錄</h3>
        <ol class="timeline">
          ${events.map((ev) => `
            <li>
              <span class="when">${new Date(ev.at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span><strong>${esc(ev.byMe ? '我' : ev.actorName)}</strong> ${ACTION_NAME[ev.action] || ev.action}${ev.note ? `（${esc(ev.note)}）` : ''}</span>
            </li>`).join('')}
        </ol>
        <button class="btn ghost" data-close>關閉</button>`;
    } catch (err) {
      el.innerHTML = `<p>😿 ${esc(err.message)}</p><button class="btn ghost" data-close>關閉</button>`;
    }
  }

  let lastSnapshot = '';

  /**
   * 重新抓資料。quiet = true 時是背景同步：抓不到就不顯示錯誤，資料沒變就不重畫。
   * 回傳資料有沒有改變。
   */
  async function refresh({ quiet = false } = {}) {
    let fresh;
    try {
      fresh = (await api('/api/loans')).loans;
    } catch (err) {
      if (!quiet) container.innerHTML = `<section class="card"><p class="hint">😿 ${esc(err.message)}</p></section>`;
      return false;
    }
    const snapshot = JSON.stringify(fresh);
    const changed = snapshot !== lastSnapshot;
    lastSnapshot = snapshot;
    loans = fresh;
    if (!changed && loaded) return false;
    render();
    // 第一次載入以外（例如同意、還款、對方有新動作），通知統整卡片更新
    if (loaded) ctx.onChange?.();
    loaded = true;
    return changed;
  }

  let loaded = false;
  refresh();
  return { refresh };
}
