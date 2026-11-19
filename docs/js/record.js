// 對話式記帳：打一句話 → 解析 → 顯示可修改的卡片 → 缺漏追問 → 確認送出

import { api } from './api.js';
import { esc, toast, withBusy, money, todayTaipei } from './ui.js';

/**
 * 在 container 裡放入記帳區。
 * ctx = { me: {nickname}, partner: {nickname}, onSaved: () => void }
 */
export function mountRecorder(container, ctx) {
  const partner = ctx.partner.nickname;
  let draft = null;        // 目前的草稿 { amount, direction, item, date }
  let source = 'rules';    // 解析來源

  container.innerHTML = `
    <section class="card chat">
      <h2>📒 記一筆</h2>
      <div class="chat-log" id="chat-log" aria-live="polite"></div>
      <div id="draft-card"></div>
      <form class="chat-input" id="chat-form" autocomplete="off">
        <input id="chat-text" maxlength="200" placeholder="例如：昨天幫${esc(partner)}付晚餐 350" />
        <button class="btn send" type="submit" aria-label="送出">送出</button>
      </form>
    </section>`;

  const log = container.querySelector('#chat-log');
  const cardBox = container.querySelector('#draft-card');
  const form = container.querySelector('#chat-form');
  const input = container.querySelector('#chat-text');

  function say(who, text) {
    const div = document.createElement('div');
    div.className = `bubble ${who}`;
    div.innerHTML = who === 'bot' ? `<span class="who">🐸</span><p>${esc(text)}</p>` : `<p>${esc(text)}</p>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  say('bot', `嗨！跟我說一句話就能記帳，例如「昨天幫${partner}付晚餐 350」或「${partner}幫我付咖啡 120」。`);

  // 和後端相同的檢查規則
  const missingOf = (d) => {
    const m = [];
    if (!(Number.isInteger(d.amount) && d.amount > 0)) m.push('amount');
    if (!['me_lent', 'partner_lent'].includes(d.direction)) m.push('direction');
    if (!(d.item && d.item.trim())) m.push('item');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) m.push('date');
    return m;
  };

  function renderCard() {
    if (!draft) {
      cardBox.innerHTML = '';
      return;
    }
    const missing = missingOf(draft);
    const miss = (k) => (missing.includes(k) ? ' missing' : '');
    const today = todayTaipei();
    cardBox.innerHTML = `
      <div class="draft">
        <div class="draft-title">請檢查一下 ✏️ <small>可以直接修改</small></div>
        <label class="field${miss('amount')}">金額
          <input type="number" inputmode="numeric" min="1" step="1" id="f-amount" value="${draft.amount ?? ''}" placeholder="例如 350" />
        </label>
        <div class="field${miss('direction')}">誰欠誰
          <div class="seg">
            <button type="button" data-dir="me_lent" class="${draft.direction === 'me_lent' ? 'on' : ''}">我借給${esc(partner)}<small>${esc(partner)}欠我</small></button>
            <button type="button" data-dir="partner_lent" class="${draft.direction === 'partner_lent' ? 'on' : ''}">${esc(partner)}借給我<small>我欠${esc(partner)}</small></button>
          </div>
        </div>
        <label class="field${miss('item')}">項目
          <input id="f-item" maxlength="30" value="${esc(draft.item ?? '')}" placeholder="例如 晚餐" />
        </label>
        <div class="field${miss('date')}">日期
          <input type="date" id="f-date" max="${today}" value="${draft.date ?? ''}" />
          <div class="quick">
            <button type="button" data-date="${today}">今天</button>
            <button type="button" data-date="${todayTaipei(-1)}">昨天</button>
            <button type="button" data-date="${todayTaipei(-2)}">前天</button>
          </div>
        </div>
        <div class="row">
          <button type="button" class="btn ghost" id="d-cancel">不記了</button>
          <button type="button" class="btn" id="d-submit" ${missing.length ? 'disabled' : ''}>確認送出</button>
        </div>
        ${missing.length ? '<p class="hint center-text">紅色的欄位還沒填好喔</p>' : `<p class="hint center-text">送出後要等${esc(partner)}同意才會算進統整</p>`}
      </div>`;

    // 修改欄位時同步更新草稿（不重畫整張卡，避免輸入時跳掉）
    const refreshState = () => {
      const m = missingOf(draft);
      cardBox.querySelector('#d-submit').disabled = m.length > 0;
      for (const [key, sel] of [['amount', '#f-amount'], ['item', '#f-item'], ['date', '#f-date']]) {
        cardBox.querySelector(sel).closest('.field').classList.toggle('missing', m.includes(key));
      }
    };
    cardBox.querySelector('#f-amount').oninput = (e) => {
      const n = Number(e.target.value);
      draft.amount = Number.isInteger(n) && n > 0 ? n : null;
      refreshState();
    };
    cardBox.querySelector('#f-item').oninput = (e) => {
      draft.item = e.target.value.trim() || null;
      refreshState();
    };
    cardBox.querySelector('#f-date').onchange = (e) => {
      draft.date = e.target.value || null;
      refreshState();
    };
    cardBox.querySelectorAll('[data-dir]').forEach((b) => {
      b.onclick = () => {
        draft.direction = b.dataset.dir;
        renderCard();
      };
    });
    cardBox.querySelectorAll('[data-date]').forEach((b) => {
      b.onclick = () => {
        draft.date = b.dataset.date;
        renderCard();
      };
    });
    cardBox.querySelector('#d-cancel').onclick = () => {
      draft = null;
      renderCard();
      say('bot', '好的，這筆先不記 🐸');
    };
    cardBox.querySelector('#d-submit').onclick = (e) =>
      withBusy(e.currentTarget, async () => {
        if (draft.date > today) throw new Error('日期不能是未來的日子喔');
        const { loan } = await api('/api/loans', {
          method: 'POST',
          body: { ...draft, parseSource: source, inputChannel: 'web' },
        });
        const who = loan.borrower.isMe ? `我欠${partner}` : `${partner}欠我`;
        say('bot', `記好了！${loan.item} ${money(loan.amount)}（${who}），等${partner}確認喔 🐑`);
        toast('已送出，等對方確認', 'ok');
        draft = null;
        renderCard();
        ctx.onSaved?.();
      });
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    say('me', text);
    const button = form.querySelector('button');
    await withBusy(button, async () => {
      const result = await api('/api/parse', { method: 'POST', body: { text, draft } });
      draft = result.fields;
      source = result.source;
      if (result.notice) say('bot', result.notice);
      say('bot', result.question || '幫你整理好了，確認沒問題就按「確認送出」！');
      renderCard();
    });
    input.focus();
  };
}
