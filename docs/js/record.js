// 對話式記帳：打字或說話 → 解析 → 顯示可修改的卡片 → 缺漏追問 → 確認送出
// 第 10 階段：🎤 語音（錄音交給 Gemini 理解）；不能錄音時提示改用鍵盤麥克風

import { api } from './api.js';
import { esc, toast, withBusy, money, todayTaipei, openModal } from './ui.js';
import { canRecord, startRecording } from './voice.js';
import { playSound, setRecording } from './sound.js';

/**
 * 在 container 裡放入記帳區。
 * ctx = { me: {nickname}, partner: {nickname}, onSaved: () => void }
 */
export function mountRecorder(container, ctx) {
  const partner = ctx.partner.nickname;
  let draft = null;        // 目前的草稿 { amount, direction, item, date }
  let source = 'rules';    // 解析來源
  let channel = 'web';     // 這筆是用打字（web）還是語音（voice）
  let recording = null;    // 錄音中的控制器

  container.innerHTML = `
    <section class="card chat">
      <h2>📒 記一筆</h2>
      <div class="chat-log" id="chat-log" aria-live="polite"></div>
      <div id="draft-card"></div>
      <form class="chat-input" id="chat-form" autocomplete="off">
        <button class="mic" type="button" id="mic" aria-label="按一下開始說話">🎤</button>
        <input id="chat-text" maxlength="200" placeholder="例如：昨天幫${esc(partner)}付晚餐 350" />
        <button class="btn send" type="submit" aria-label="送出">送出</button>
      </form>
    </section>`;

  const log = container.querySelector('#chat-log');
  const cardBox = container.querySelector('#draft-card');
  const form = container.querySelector('#chat-form');
  const input = container.querySelector('#chat-text');
  const micBtn = container.querySelector('#mic');

  function say(who, text) {
    const div = document.createElement('div');
    div.className = `bubble ${who}`;
    div.innerHTML = who === 'bot' ? `<span class="who">🐸</span><p>${esc(text)}</p>` : `<p>${esc(text)}</p>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
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
      channel = 'web';
      renderCard();
      say('bot', '好的，這筆先不記 🐸');
    };
    cardBox.querySelector('#d-submit').onclick = (e) =>
      withBusy(e.currentTarget, async () => {
        if (draft.date > today) throw new Error('日期不能是未來的日子喔');
        const { loan } = await api('/api/loans', {
          method: 'POST',
          body: { ...draft, parseSource: source, inputChannel: channel },
        });
        const who = loan.borrower.isMe ? `我欠${partner}` : `${partner}欠我`;
        say('bot', `記好了！${loan.item} ${money(loan.amount)}（${who}），等${partner}確認喔 🐑`);
        toast('已送出，等對方確認', 'ok');
        playSound('send');
        draft = null;
        channel = 'web';
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
      handleResult(result);
    });
    input.focus();
  };

  /** 顯示解析結果（打字和語音共用） */
  function handleResult(result) {
    draft = result.fields;
    source = result.source;
    say('bot', result.question || '幫你整理好了，確認沒問題就按「確認送出」！');
    // Gemini 無法使用時的小提示（記帳流程照常）
    if (result.notice) {
      const chip = document.createElement('div');
      chip.className = 'notice-chip';
      chip.textContent = `🔧 ${result.notice}`;
      log.appendChild(chip);
      log.scrollTop = log.scrollHeight;
    }
    renderCard();
  }

  // ───── 🎤 語音 ─────

  /** 不能錄音時（例如 iPhone 舊版 Safari、或沒有允許麥克風）：教使用者用鍵盤上的麥克風 */
  function showKeyboardMicHelp(reason) {
    const { el, close } = openModal(`
      <h2>🎤 改用鍵盤上的麥克風</h2>
      <p>${esc(reason)}</p>
      <ol class="steps">
        <li>點一下下面的輸入框，叫出鍵盤。</li>
        <li>按鍵盤上的 <b>🎙️ 麥克風</b>（iPhone 在鍵盤右下角或空白鍵旁）。</li>
        <li>說出要記的帳，例如「昨天幫${esc(partner)}付晚餐三百五」。</li>
        <li>說完按「送出」，小青蛙一樣會幫你整理。</li>
      </ol>
      <button class="btn" data-close id="to-input">好，去輸入框</button>`);
    el.querySelector('#to-input').addEventListener('click', () => {
      close();
      input.focus();
    });
  }

  function setMicState(state, seconds = 0) {
    micBtn.classList.toggle('rec', state === 'rec');
    micBtn.disabled = state === 'busy';
    micBtn.textContent = state === 'rec' ? `■ ${seconds}s` : state === 'busy' ? '…' : '🎤';
    micBtn.setAttribute('aria-label', state === 'rec' ? '按一下停止錄音' : '按一下開始說話');
    input.disabled = state !== 'idle';
  }

  async function stopAndSend() {
    const rec = recording;
    recording = null;
    setMicState('busy');
    try {
      const audio = await rec.stop();
      setRecording(false);
      playSound('recStop');
      const bubble = say('me', `🎤 語音（${audio.seconds} 秒）`);
      const result = await api('/api/parse-voice', {
        method: 'POST',
        body: { audio: { mimeType: 'audio/wav', base64: audio.base64 }, draft },
      });
      if (result.transcript) bubble.querySelector('p').textContent = `🎤 「${result.transcript}」`;
      channel = 'voice';
      handleResult(result);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setRecording(false); // 錄音失敗也要讓背景音樂回來
      setMicState('idle');
    }
  }

  micBtn.onclick = async () => {
    if (recording) return stopAndSend();
    if (!canRecord()) {
      return showKeyboardMicHelp('這個瀏覽器不支援直接錄音（常見於 iPhone 較舊的 Safari）。');
    }
    try {
      playSound('recStart');
      setRecording(true); // 錄音時暫停背景音樂
      recording = await startRecording({
        onTick: (s) => recording && setMicState('rec', s),
        onAutoStop: () => {
          if (!recording) return;
          toast('已經 30 秒了，自動停止', 'info');
          stopAndSend();
        },
      });
      setMicState('rec', 0);
      say('bot', '我在聽～說完再按一下 ■ 停止 🐸');
    } catch (err) {
      recording = null;
      setRecording(false);
      setMicState('idle');
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      showKeyboardMicHelp(denied ? '沒有取得麥克風權限（可以到瀏覽器設定裡允許）。' : '這支手機現在無法錄音。');
    }
  };

  /** 計算機按「帶入記帳金額」：填進草稿的金額欄（沒有草稿就開一張新的） */
  function setAmount(amount) {
    if (draft) {
      draft.amount = amount;
    } else {
      draft = { amount, direction: null, item: null, date: null };
      source = 'manual';
      channel = 'web';
    }
    say('bot', `金額 ${money(amount)} 幫你填好了！其他欄位可以直接點選，或打字告訴我（例如「昨天幫${partner}付晚餐」）🐸`);
    renderCard();
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return { setAmount };
}
