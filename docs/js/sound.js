// 音效與背景音樂：全部用瀏覽器內建的「Web Audio」（用程式即時產生聲音）做出來，
// 不用下載任何音樂檔，也沒有版權問題。
//
// 規則：
// - 瀏覽器不准網頁自己出聲，要等使用者第一次點畫面後才開始（背景音樂也是）。
// - 設定（音效開關、音樂開關、音量、按鍵聲）只存在這支手機。
// - 切到別的 APP 或關掉螢幕時，聲音全部暫停；回來再繼續。
// - 錄音時暫停背景音樂，避免被麥克風錄進去。

const KEY = 'guamie_sound';
const DEFAULTS = { sfx: true, music: true, volume: 0.6, keys: true };

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

const settings = loadSettings();

function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch { /* 無痕模式可能無法儲存，忽略 */ }
}

export function getSoundSettings() {
  return { ...settings };
}

let ctx = null;        // 聲音引擎（AudioContext），第一次點畫面後才建立
let master = null;     // 總音量
let musicBus = null;   // 背景音樂的音量（每次開始播放都換一個新的）
let musicTimer = null; // 背景音樂的排程計時器
let recording = false; // 錄音中：不放音樂

/** iPhone：設成「環境音」，會跟其他 APP 的音樂混在一起播、靜音開關打開時不出聲 */
function setAmbientSession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'ambient';
  } catch { /* 不支援就算了 */ }
}

function ensureContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  setAmbientSession();
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = settings.volume;
  master.connect(ctx.destination);
  return ctx;
}

// 第一次點畫面時「解鎖」聲音，並開始背景音樂
function unlock() {
  if (!ensureContext()) return;
  if (ctx.state === 'suspended' && document.visibilityState === 'visible') ctx.resume();
  if (settings.music && !musicTimer) startMusic();
}
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, unlock, { capture: true, passive: true }));

// 切到背景就暫停，回來再繼續
document.addEventListener('visibilitychange', () => {
  if (!ctx) return;
  if (document.visibilityState === 'visible') ctx.resume();
  else ctx.suspend();
});

// ───────── 小工具：音名 → 頻率 ─────────

const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** 'A4' → 440，'C#5' → 554… */
function freq(name) {
  const m = /^([A-G])(#|b)?(\d)$/.exec(name);
  const semitone = NOTE_INDEX[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const midi = 12 * (Number(m[3]) + 1) + semitone;
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * 播一個音：t 開始時間、f 頻率、dur 長度（秒）
 * opt：type 波形、vol 音量、slide 結束時滑到的頻率、attack 起音、out 接到哪裡
 */
function tone(t, f, dur, { type = 'sine', vol = 0.3, slide, attack = 0.005, out } = {}) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(out || master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
  return { osc, g };
}

/** 青蛙「呱」：粗粗的鋸齒波 + 快速抖動，再用濾波器修圓 */
function croak(t, base = 210) {
  const dur = 0.16;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1100;
  filter.Q.value = 6;
  filter.connect(master);
  const { g } = tone(t, base, dur, { type: 'sawtooth', vol: 0.32, slide: base * 0.72, attack: 0.01, out: filter });
  // 抖動（每秒 38 次大小聲變化），聽起來就像喉嚨在震
  const lfo = ctx.createOscillator();
  const depth = ctx.createGain();
  lfo.frequency.value = 38;
  depth.gain.value = 0.18;
  lfo.connect(depth);
  depth.connect(g.gain);
  lfo.start(t);
  lfo.stop(t + dur + 0.05);
}

// ───────── 音效 ─────────

const SFX = {
  /** 記帳送出、修改重送：往上的「叮咚」 */
  send(t) {
    tone(t, freq('E5'), 0.25, { type: 'triangle', vol: 0.3 });
    tone(t + 0.12, freq('A5'), 0.45, { type: 'triangle', vol: 0.3 });
  },
  /** 同意：「呱呱！」 */
  approve(t) {
    croak(t, 220);
    croak(t + 0.19, 260);
  },
  /** 還款：投硬幣「鏘啷」 */
  coin(t) {
    tone(t, freq('B5'), 0.09, { type: 'square', vol: 0.12 });
    tone(t + 0.08, freq('E6'), 0.5, { type: 'square', vol: 0.12 });
  },
  /** 否定、退回、撤回、刪除：柔和偏低的「噗」 */
  soft(t) {
    tone(t, 320, 0.22, { vol: 0.35, slide: 130 });
  },
  /** 兩不相欠：慶祝小旋律 */
  celebrate(t) {
    ['C5', 'E5', 'G5', 'C6'].forEach((n, i) => tone(t + i * 0.1, freq(n), 0.3, { type: 'triangle', vol: 0.25 }));
    ['C5', 'E5', 'G5', 'C6'].forEach((n) => tone(t + 0.45, freq(n), 0.9, { type: 'triangle', vol: 0.12 }));
  },
  /** 錯誤：短短的低音「嘟嘟」 */
  error(t) {
    tone(t, 220, 0.12, { type: 'triangle', vol: 0.3 });
    tone(t + 0.15, 180, 0.18, { type: 'triangle', vol: 0.3 });
  },
  /** 開始錄音 */
  recStart(t) {
    tone(t, 880, 0.12, { vol: 0.25 });
  },
  /** 停止錄音 */
  recStop(t) {
    tone(t, 660, 0.14, { vol: 0.25 });
  },
  /** 對方有新動作：輕輕的「啵」 */
  pop(t) {
    tone(t, 520, 0.09, { vol: 0.3, slide: 1100 });
  },
  /** 計算機按鍵：很輕的「嗒」 */
  tap(t) {
    tone(t, 1300, 0.035, { vol: 0.12, attack: 0.002 });
  },
  /** 圓角大按鈕：軟軟的「啵」，像按下 Q 彈的按鈕 */
  press(t) {
    tone(t, 700, 0.08, { type: 'triangle', vol: 0.22, slide: 480, attack: 0.003 });
    tone(t, 1400, 0.03, { vol: 0.05, attack: 0.002 });
  },
};

/** 播放音效，例如 playSound('coin') */
export function playSound(name) {
  if (!settings.sfx || !SFX[name]) return;
  if ((name === 'tap' || name === 'press') && !settings.keys) return;
  if (!ensureContext()) return;
  if (ctx.state === 'running') {
    SFX[name](ctx.currentTime + 0.01);
  } else if (ctx.state === 'suspended' && document.visibilityState === 'visible') {
    // 第一次點畫面時聲音引擎還在啟動，等它好了再播
    ctx.resume().then(() => SFX[name](ctx.currentTime + 0.01)).catch(() => {});
  }
}

// 所有圓角大按鈕（.btn，例如「用 Google 帳號登入」「確認送出」「同意」）按下時都有「啵」聲
document.addEventListener(
  'click',
  (e) => {
    const btn = e.target.closest?.('.btn');
    if (btn && !btn.disabled) playSound('press');
  },
  { capture: true },
);

// ───────── 背景音樂：可愛的木琴小曲（每分鐘 100 拍、16 小節約 38 秒，一直重播） ─────────

const BEAT = 0.6; // 一拍 0.6 秒
const CHORDS = {
  C: { notes: ['C4', 'E4', 'G4'], bass: 'C3' },
  G: { notes: ['B3', 'D4', 'G4'], bass: 'G2' },
  Am: { notes: ['A3', 'C4', 'E4'], bass: 'A2' },
  F: { notes: ['A3', 'C4', 'F4'], bass: 'F2' },
};
const PROGRESSION = ['C', 'G', 'Am', 'F', 'C', 'G', 'F', 'G', 'Am', 'F', 'C', 'G', 'F', 'G', 'C', 'C'];
// 每小節的旋律：[第幾拍開始, 音, 幾拍長]
const MELODY = [
  [[0, 'E5', 1], [1, 'G5', 1], [2, 'A5', 0.5], [2.5, 'G5', 0.5], [3, 'E5', 1]],
  [[0, 'D5', 1], [1, 'B4', 0.5], [1.5, 'D5', 0.5], [2, 'G5', 2]],
  [[0, 'C5', 1], [1, 'E5', 1], [2, 'A5', 1], [3, 'G5', 1]],
  [[0, 'F5', 1.5], [1.5, 'E5', 0.5], [2, 'C5', 2]],
  [[0, 'E5', 0.5], [0.5, 'G5', 0.5], [1, 'C6', 1], [2, 'B5', 0.5], [2.5, 'A5', 0.5], [3, 'G5', 1]],
  [[0, 'D5', 1], [1, 'G5', 1], [2, 'B5', 1], [3, 'A5', 1]],
  [[0, 'A5', 1], [1, 'G5', 0.5], [1.5, 'F5', 0.5], [2, 'E5', 1], [3, 'D5', 1]],
  [[0, 'D5', 1], [1, 'E5', 0.5], [1.5, 'D5', 0.5], [2, 'G5', 2]],
  [[0, 'A5', 1], [1, 'C6', 1], [2, 'A5', 0.5], [2.5, 'G5', 0.5], [3, 'E5', 1]],
  [[0, 'F5', 1], [1, 'A5', 1], [2, 'C6', 2]],
  [[0, 'G5', 1], [1, 'E5', 0.5], [1.5, 'G5', 0.5], [2, 'C6', 1], [3, 'G5', 1]],
  [[0, 'B5', 1], [1, 'A5', 0.5], [1.5, 'G5', 0.5], [2, 'D5', 2]],
  [[0, 'C5', 0.5], [0.5, 'F5', 0.5], [1, 'A5', 1], [2, 'G5', 0.5], [2.5, 'F5', 0.5], [3, 'E5', 1]],
  [[0, 'D5', 1], [1, 'G5', 1], [2, 'B5', 0.5], [2.5, 'A5', 0.5], [3, 'G5', 1]],
  [[0, 'E5', 1], [1, 'D5', 0.5], [1.5, 'E5', 0.5], [2, 'G5', 1], [3, 'E5', 1]],
  [[0, 'C5', 2], [2, 'G4', 0.5], [2.5, 'A4', 0.5], [3, 'B4', 1]],
];

/** 整首歌攤平成一串「第幾拍要播什麼」 */
const SONG = (() => {
  const events = [];
  PROGRESSION.forEach((name, bar) => {
    const start = bar * 4;
    const chord = CHORDS[name];
    events.push({ beat: start, kind: 'bass', note: chord.bass });
    events.push({ beat: start + 2, kind: 'bass', note: chord.bass });
    events.push({ beat: start + 1, kind: 'chord', notes: chord.notes });
    events.push({ beat: start + 3, kind: 'chord', notes: chord.notes });
    MELODY[bar].forEach(([b, note, len]) => events.push({ beat: start + b, kind: 'melody', note, len }));
  });
  return events.sort((a, b) => a.beat - b.beat);
})();
const SONG_BEATS = PROGRESSION.length * 4;

function playEvent(e, t) {
  if (e.kind === 'melody') {
    // 木琴：主音 + 很小聲的高泛音，敲下去很快變小聲
    const dur = Math.min(e.len * BEAT, 0.7);
    tone(t, freq(e.note), dur, { vol: 0.32, out: musicBus });
    tone(t, freq(e.note) * 4, 0.12, { vol: 0.05, out: musicBus });
  } else if (e.kind === 'chord') {
    // 烏克麗麗刷弦：三個音一個接一個很快彈出來
    e.notes.forEach((n, i) => tone(t + i * 0.018, freq(n), 0.35, { type: 'triangle', vol: 0.09, out: musicBus }));
  } else {
    tone(t, freq(e.note), 0.5, { type: 'triangle', vol: 0.28, out: musicBus });
  }
}

function startMusic() {
  if (!ensureContext() || musicTimer || recording) return;
  musicBus = ctx.createGain();
  musicBus.gain.value = 0.32; // 背景音樂比音效小聲
  musicBus.connect(master);
  let songStart = ctx.currentTime + 0.1;
  let index = 0;
  // 每 0.2 秒排好接下來 1 秒內的音符
  const schedule = () => {
    const horizon = ctx.currentTime + 1;
    for (;;) {
      if (index >= SONG.length) {
        index = 0;
        songStart += SONG_BEATS * BEAT;
      }
      const e = SONG[index];
      const t = songStart + e.beat * BEAT;
      if (t > horizon) break;
      if (t >= ctx.currentTime) playEvent(e, t);
      index += 1;
    }
  };
  schedule();
  musicTimer = setInterval(schedule, 200);
}

function stopMusic() {
  clearInterval(musicTimer);
  musicTimer = null;
  if (musicBus) {
    const bus = musicBus;
    bus.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    setTimeout(() => bus.disconnect(), 400);
    musicBus = null;
  }
}

/** 錄音開始／結束時呼叫：錄音中不放背景音樂 */
export function setRecording(on) {
  recording = on;
  if (on) {
    stopMusic();
    // iPhone：錄音前改回自動模式，否則麥克風可能打不開
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'auto';
    } catch { /* 忽略 */ }
  } else {
    setAmbientSession();
    if (settings.music && ctx) startMusic();
  }
}

// ───────── 設定畫面 ─────────

export function updateSoundSettings(patch) {
  Object.assign(settings, patch);
  saveSettings();
  if (!ensureContext()) return;
  master.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.03);
  if (settings.music) startMusic();
  else stopMusic();
}

/** 在 ⚙️ 設定裡放「🔊 聲音」區塊 */
export function mountSoundSettings(container) {
  const supported = Boolean(window.AudioContext || window.webkitAudioContext);
  if (!supported) {
    container.innerHTML = '<section class="card"><h2>🔊 聲音</h2><p class="hint">這個瀏覽器不支援網頁音效。</p></section>';
    return;
  }
  const s = getSoundSettings();
  const sw = (id, label, on, hint = '') => `
    <label class="switch-row">
      <span>${label}${hint ? `<small class="hint">${hint}</small>` : ''}</span>
      <input type="checkbox" role="switch" id="${id}" ${on ? 'checked' : ''} />
    </label>`;
  container.innerHTML = `
    <section class="card sound-settings">
      <h2>🔊 聲音</h2>
      ${sw('snd-sfx', '音效', s.sfx, '記帳、同意、還款時的小聲音')}
      ${sw('snd-music', '背景音樂', s.music, '可愛的木琴小曲')}
      ${sw('snd-keys', '按鍵聲', s.keys, '按鈕和計算機按下時的小聲音')}
      <label class="volume-row">音量
        <input type="range" id="snd-volume" min="0" max="1" step="0.05" value="${s.volume}" aria-label="音量" />
      </label>
      <p class="hint">手機開靜音時不會出聲。設定只存在這支手機。</p>
    </section>`;
  const $ = (id) => container.querySelector(id);
  $('#snd-sfx').onchange = (e) => {
    updateSoundSettings({ sfx: e.target.checked });
    playSound('pop');
  };
  $('#snd-music').onchange = (e) => updateSoundSettings({ music: e.target.checked });
  $('#snd-keys').onchange = (e) => {
    updateSoundSettings({ keys: e.target.checked });
    playSound('tap');
  };
  $('#snd-volume').oninput = (e) => updateSoundSettings({ volume: Number(e.target.value) });
  $('#snd-volume').onchange = () => playSound('send'); // 放開滑桿時試聽
}
