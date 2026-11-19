// 語音錄製：用手機麥克風錄音 → 轉成 Gemini 看得懂的 WAV（16kHz 單聲道）→ 交給後端
// 不使用瀏覽器內建的語音辨識（Web Speech API），理解一律交給 Gemini。

const MAX_MS = 30000;          // 最長 30 秒
const TARGET_RATE = 16000;     // 16kHz 對說話已經很清楚，檔案也小

/** 這個瀏覽器能不能錄音？（iPhone 舊版 Safari 可能不行） */
export function canRecord() {
  return Boolean(
    navigator.mediaDevices?.getUserMedia &&
    window.MediaRecorder &&
    (window.AudioContext || window.webkitAudioContext) &&
    (window.OfflineAudioContext || window.webkitOfflineAudioContext),
  );
}

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
  return candidates.find((t) => window.MediaRecorder.isTypeSupported?.(t)) || '';
}

/**
 * 開始錄音。回傳 { stop, cancel }：
 *   stop()   → Promise<{ base64, seconds }>
 *   cancel() → 丟掉這次錄音
 * onTick(秒數) 每秒呼叫一次；onAutoStop() 在滿 30 秒自動停止時呼叫。
 */
export async function startRecording({ onTick, onAutoStop } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const started = Date.now();
  const ticker = setInterval(() => onTick?.(Math.floor((Date.now() - started) / 1000)), 250);
  const autoStop = setTimeout(() => onAutoStop?.(), MAX_MS);

  const stopped = new Promise((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start();

  const cleanup = () => {
    clearInterval(ticker);
    clearTimeout(autoStop);
    stream.getTracks().forEach((t) => t.stop()); // 關掉麥克風（手機上的紅點會消失）
  };

  return {
    async stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      cleanup();
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      return encodeForGemini(blob);
    },
    cancel() {
      if (recorder.state !== 'inactive') recorder.stop();
      cleanup();
    },
  };
}

/** 把錄音（webm、mp4…各家瀏覽器格式不同）統一轉成 16kHz 單聲道 WAV 的文字編碼 */
export async function encodeForGemini(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new AC();
  const arrayBuffer = await blob.arrayBuffer();
  // 舊版 Safari 只支援 callback 寫法
  const decoded = await new Promise((resolve, reject) => ctx.decodeAudioData(arrayBuffer, resolve, reject));
  ctx.close?.();

  if (decoded.duration < 0.6) throw new Error('錄音太短了，請按下後再說一次');

  const length = Math.ceil(decoded.duration * TARGET_RATE);
  const offline = new OAC(1, length, TARGET_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await new Promise((resolve) => {
    const p = offline.startRendering();
    if (p?.then) p.then(resolve);
    else offline.oncomplete = (e) => resolve(e.renderedBuffer);
  });

  const wav = pcmToWav(rendered.getChannelData(0), TARGET_RATE);
  return { base64: bytesToBase64(wav), seconds: Math.round(decoded.duration) };
}

function pcmToWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);     // fmt 區塊大小
  view.setUint16(20, 1, true);      // PCM
  view.setUint16(22, 1, true);      // 單聲道
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);     // 16 位元
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
