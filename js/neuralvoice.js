/*
 * Neural voice cloning, on-device.
 *
 * Runs Kyutai's Pocket TTS (a 100M-parameter neural text-to-speech model with
 * zero-shot voice cloning) through onnxruntime-web in a Web Worker. A short
 * sample of the user's speech is encoded into a voice, and every sentence is
 * then generated in that voice. Inference is local: the user's audio and text
 * never leave the browser.
 *
 * The model weights (~216 MB) are not in this repository. They load from
 * vendor/models/pocket-tts/en/ when that folder is present (self-hosted), and
 * otherwise are downloaded once from Hugging Face and cached by the browser.
 */
import { Engine } from '../vendor/pocket-tts/engine.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;
const LOCAL_MODELS = VENDOR + 'models/pocket-tts/en/';
const REMOTE_MODELS = 'https://huggingface.co/thewh1teagle/pocket-tts-onnx/resolve/main/en/';

let enginePromise = null;
let engine = null;
let clonedSeconds = 0;

// Where the model can come from, in order: self-hosted next to zoope, Hugging Face, and a
// public mirror of Hugging Face (for networks that block huggingface.co).
const SOURCES = [
  { url: LOCAL_MODELS, source: 'local' },
  { url: REMOTE_MODELS, source: 'remote' },
  { url: 'https://hf-mirror.com/thewh1teagle/pocket-tts-onnx/resolve/main/en/', source: 'mirror' }
];
async function reachable(base) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(base + 'manifest.json', { cache: 'no-store', signal: ctl.signal });
    return res.ok;
  } catch (e) { return false; } finally { clearTimeout(t); }
}
async function modelsUrl() {
  for (const s of SOURCES) if (await reachable(s.url)) return s;
  throw new Error('the voice model could not be downloaded: huggingface.co and its mirror are blocked or offline on this network');
}

// Phones get far less memory per tab; the runtime then skips its memory arena
// and frees the voice encoder as soon as the voice is made.
const LOW_MEMORY = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) || (navigator.deviceMemory && navigator.deviceMemory < 4);

/* The made voice is kept on this device (IndexedDB), so later visits don't need the encoder. */
function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('zoope-voice', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('voice');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function saveVoice(cond, seconds) {
  try {
    const d = await db();
    await new Promise((res, rej) => { const t = d.transaction('voice', 'readwrite'); t.objectStore('voice').put({ cond, seconds }, 'mine'); t.oncomplete = res; t.onerror = () => rej(t.error); });
  } catch (e) { /* storage unavailable: the voice lasts this visit */ }
}
async function savedVoice() {
  try {
    const d = await db();
    return await new Promise((res) => { const r = d.transaction('voice').objectStore('voice').get('mine'); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
  } catch (e) { return null; }
}
export async function hasSaved() { return !!(await savedVoice()); }
export async function forget() {
  try { const d = await db(); d.transaction('voice', 'readwrite').objectStore('voice').delete('mine'); } catch (e) { /* nothing saved */ }
}

export function load(onProgress) {
  if (!enginePromise) {
    enginePromise = modelsUrl().then(({ url, source }) => Engine.load({
      language: 'english',
      lowMemory: LOW_MEMORY,
      modelsUrl: url,
      ortWasmUrl: VENDOR + 'onnxruntime/',
      worker: () => new Worker(VENDOR + 'pocket-tts/worker.js', { type: 'module' }),
      onProgress: (stage, p) => {
        if (!onProgress || !p) return;
        const frac = p.total ? p.loaded / p.total : 0;
        onProgress(frac, (p.cached ? 'Loading ' : source === 'local' ? 'Loading ' : 'Downloading ') + stage);
      }
    })).then((e) => { engine = e; return e; });
    enginePromise.catch(() => { enginePromise = null; });
  }
  return enginePromise;
}

export function ready() { return !!engine && clonedSeconds > 0; }
export function loaded() { return !!engine; }
export function sampleRate() { return engine ? engine.sampleRate : 24000; }

function resample(data, from, to) {
  if (from === to) return data;
  const ratio = from / to, n = Math.floor(data.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0;
    out[i] = data[i0] * (1 - f) + (data[i0 + 1] || 0) * f;
  }
  return out;
}

/* Encodes the user's voice from mono samples at `rate`. Up to 20 s is used. */
export async function clone(samples, rate, onProgress) {
  try {
    return await cloneOnce(samples, rate, onProgress);
  } catch (err) {
    // a phone can run out of memory part-way; start over once in a fresh worker,
    // with nothing else loaded, before giving up
    reset();
    if (onProgress) onProgress(0, 'Retrying with a clean start');
    return await cloneOnce(samples, rate, onProgress);
  }
}
async function cloneOnce(samples, rate, onProgress) {
  const e = await load(onProgress);
  const input = resample(samples, rate, e.sampleRate);
  const result = await e.clone(input, (stage, p) => {
    if (onProgress && p && p.total) onProgress(p.loaded / p.total, 'Encoding your voice');
  });
  clonedSeconds = result.seconds;
  if (result.cond) await saveVoice(result.cond, result.seconds);
  return result;
}
/* Drops the worker and everything loaded in it. */
export function reset() {
  if (engine) { try { engine.dispose(); } catch (e) { /* gone */ } }
  engine = null; enginePromise = null; clonedSeconds = 0;
}

/* Loads the model with the voice made earlier on this device. Resolves false when there is none. */
export async function restore(onProgress) {
  const saved = await savedVoice();
  if (!saved) return false;
  const e = await load(onProgress);
  await e.setVoice(saved.cond);
  clonedSeconds = saved.seconds || 1;
  return true;
}

/*
 * Speaks text in the cloned voice, streaming frames to the speakers as they are
 * generated. onLevel(0..1) drives the avatar's mouth.
 * out (optional): { context, destination, onEnvelope({ at, step, levels }) } sends
 * the voice into a stream (a real meeting) instead of the speakers; the mouth
 * envelope is reported with wall-clock times so a remote avatar can follow it.
 */
// Short replies made ahead of time (when the voice is ready), so "Yes?" and friends play instantly.
const phraseCache = new Map();
export async function prewarm(phrases) {
  if (!ready()) return;
  for (const p of phrases) {
    if (phraseCache.has(p)) continue;
    const parts = [];
    for await (const f of engine.speak(p, new Float32Array(1), { temperature: TEMP })) parts.push(f);
    const n = parts.reduce((a, f) => a + f.length, 0), all = new Float32Array(n);
    let o = 0; for (const f of parts) { all.set(f, o); o += f.length; }
    phraseCache.set(p, all);
  }
}
// a little variation in delivery sounds human; too much wanders off the voice
const TEMP = 0.5;
let leadSeconds = 0.25;

/*
 * Mouth timing like a real speaker: lips start moving ~50 ms before the sound,
 * so the mouth follows a timeline of shapes made from the audio itself rather
 * than reacting to what's already playing.
 */
function mouthTimeline(ac, onLevel) {
  const segs = [];
  let playing = true;
  (function tick() {
    if (!playing) return;
    const t = ac.currentTime + 0.05;
    let shape = null;
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      if (t >= s.at && t < s.at + s.shapes.length * 0.02) { const v = s.shapes[Math.floor((t - s.at) / 0.02)]; shape = { open: v[0], wide: v[1], round: v[2], teeth: v[3] }; break; }
    }
    if (onLevel) onLevel(shape || { open: 0, wide: 0, round: 0, teeth: 0 });
    requestAnimationFrame(tick);
  })();
  return {
    add(samples, rate, at) { segs.push({ at, shapes: window.ZoopeVoice.shapeTrack(samples, rate, 20) }); if (segs.length > 400) segs.splice(0, 200); },
    stop() { playing = false; if (onLevel) onLevel({ open: 0, wide: 0, round: 0, teeth: 0 }); }
  };
}

/*
 * Speaks text in the cloned voice, streaming frames to the speakers as they are
 * generated. onLevel(shape) drives the avatar's mouth.
 * out (optional): { context, destination, onEnvelope({ at, step, shapes }) } sends
 * the voice into a stream (a real meeting) instead of the speakers; the mouth
 * shapes are reported with wall-clock times so a remote avatar can follow them.
 */
export async function speak(text, onLevel, out) {
  if (!ready()) throw new Error('No cloned voice yet');
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = out ? out.context : new AC({ sampleRate: engine.sampleRate });
  await ac.resume();
  const dest = out ? out.destination : ac.destination;
  const mouth = mouthTimeline(ac, onLevel);
  let cursor = 0, started = false, lastEnd = 0, lastSrc = null;
  const play = (frames) => {
    if (!started || cursor < ac.currentTime + 0.02) cursor = ac.currentTime + 0.04;
    started = true;
    for (const frame of frames) {
      const buf = ac.createBuffer(1, frame.length, engine.sampleRate);
      buf.getChannelData(0).set(frame);
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.start(cursor);
      mouth.add(frame, engine.sampleRate, cursor);
      lastSrc = src;
      if (out && out.onEnvelope) out.onEnvelope(envelope(frame, engine.sampleRate, Date.now() + (cursor - ac.currentTime) * 1000));
      cursor += buf.duration;
    }
    lastEnd = cursor;
  };
  const cached = phraseCache.get(text);
  if (cached) play([cached]);
  else {
    // start after a short buffer; the buffer adapts to how fast this computer makes speech,
    // so playback is continuous instead of stuttering
    const LEAD = leadSeconds;
    let pending = [], pendingDur = 0, underruns = 0;
    for await (const frame of engine.speak(text, new Float32Array(1), { temperature: TEMP })) {
      pending.push(frame);
      pendingDur += frame.length / engine.sampleRate;
      const ahead = started ? cursor - ac.currentTime : 0;
      let go;
      if (!started) go = pendingDur >= LEAD;              // first: fill the buffer
      else if (ahead > 0.02) go = true;                   // playing: keep the stream continuous
      else { if (!pending.rebuffering) { underruns++; pending.rebuffering = true; } go = pendingDur >= LEAD; } // fell behind: refill once
      if (go) { play(pending); pending = []; pendingDur = 0; }
    }
    if (pending.length) play(pending);
    // learn: more buffer after a stutter, less when it was smooth
    leadSeconds = underruns ? Math.min(1.5, leadSeconds * 1.6) : Math.max(0.15, leadSeconds * 0.9);
  }
  // wait for the last piece of audio to finish (an audio event, which background tabs don't delay)
  if (lastSrc && lastEnd > ac.currentTime) await new Promise((resolve) => { lastSrc.onended = resolve; });
  mouth.stop();
  if (!out) ac.close();
}

/* Mouth shapes every 20 ms of a chunk of samples, starting at wall-clock time `at`. */
export function envelope(samples, rate, at) {
  const step = 20;
  return { at, step, shapes: window.ZoopeVoice.shapeTrack(samples, rate, step) };
}

export function cancel() { if (engine) engine.cancel(); }
