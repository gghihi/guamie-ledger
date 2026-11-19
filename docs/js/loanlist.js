// 借款清單：分成「待確認」「未還」「已還」三區
// 第 5 階段只顯示；同意、否定、還款等按鈕在第 7、8 階段加入。

import { api } from './api.js';
import { esc, money, prettyDate } from './ui.js';

const TABS = [
  { key: 'pending', label: '待確認', statuses: ['pending', 'rejected'] },
  { key: 'unpaid', label: '未還', statuses: ['unpaid', 'repay_pending'] },
  { key: 'paid', label: '已還', statuses: ['paid'] },
];

export function mountLoanList(container) {
  let loans = [];
  let tab = 'pending';

  function statusTag(loan) {
    switch (loan.status) {
      case 'pending': return loan.createdByMe ? '<span class="tag wait">等對方確認</span>' : '<span class="tag todo">等你確認</span>';
      case 'rejected': return '<span class="tag no">被否定</span>';
      case 'repay_pending': return '<span class="tag wait">已還待確認</span>';
      default: return '';
    }
  }

  function render() {
    const current = TABS.find((t) => t.key === tab);
    const rows = loans.filter((l) => current.statuses.includes(l.status));
    container.innerHTML = `
      <section class="card">
        <div class="tabs" role="tablist">
          ${TABS.map((t) => {
            const n = loans.filter((l) => t.statuses.includes(l.status)).length;
            return `<button role="tab" data-tab="${t.key}" class="${t.key === tab ? 'on' : ''}">${t.label}<span class="count">${n}</span></button>`;
          }).join('')}
        </div>
        ${rows.length ? `<ul class="loans">${rows.map(row).join('')}</ul>` : `<p class="hint center-text empty">這裡還沒有紀錄 🐑</p>`}
      </section>`;
    container.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => {
        tab = b.dataset.tab;
        render();
      };
    });
  }

  function row(l) {
    const who = `${esc(l.borrower.name)} 欠 ${esc(l.lender.name)}`;
    return `
      <li class="loan ${l.borrower.isMe ? 'i-owe' : 'owe-me'}">
        <div class="loan-main">
          <strong>${esc(l.item)}</strong>
          <small>${prettyDate(l.date)}・${who}</small>
        </div>
        <div class="loan-side">
          <span class="amount">${money(l.amount)}</span>
          ${statusTag(l)}
        </div>
      </li>`;
  }

  async function refresh() {
    try {
      loans = (await api('/api/loans')).loans;
    } catch (err) {
      container.innerHTML = `<section class="card"><p class="hint">😿 ${esc(err.message)}</p></section>`;
      return;
    }
    render();
  }

  refresh();
  return { refresh };
}
