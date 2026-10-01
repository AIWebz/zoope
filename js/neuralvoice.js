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
export async function speak(text, onLevel, out) {
  if (!ready()) throw new Error('No cloned voice yet');
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = out ? out.context : new AC({ sampleRate: engine.sampleRate });
  await ac.resume();
  const analyser = ac.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(out ? out.destination : ac.destination);
  const td = new Float32Array(analyser.fftSize);
  let playing = true, lastEnd = 0;
  (function meter() {
    if (!playing) return;
    analyser.getFloatTimeDomainData(td);
    // the mouth takes the shape of the sound being played (open, spread, rounded, teeth)
    if (onLevel) onLevel(window.ZoopeVoice.shapeOf(td, ac.sampleRate));
    requestAnimationFrame(meter);
  })();

  // Smooth playback: hold back the first half second of audio before starting, and if the
  // model ever falls behind, wait for another half second instead of playing in fragments.
  const LEAD = 0.5;
  let cursor = 0, pending = [], pendingDur = 0, started = false;
  const flush = () => {
    if (!pending.length) return;
    if (!started || cursor < ac.currentTime + 0.02) cursor = ac.currentTime + 0.05;
    started = true;
    for (const frame of pending) {
      const buf = ac.createBuffer(1, frame.length, engine.sampleRate);
      buf.getChannelData(0).set(frame);
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(analyser);
      src.start(cursor);
      if (out && out.onEnvelope) out.onEnvelope(envelope(frame, engine.sampleRate, Date.now() + (cursor - ac.currentTime) * 1000));
      cursor += buf.duration;
    }
    lastEnd = cursor;
    pending = []; pendingDur = 0;
  };
  // the worker resolves a Float32Array voice to the most recent clone
  for await (const frame of engine.speak(text, new Float32Array(1), { temperature: 0.2 })) {
    pending.push(frame);
    pendingDur += frame.length / engine.sampleRate;
    const ahead = started ? cursor - ac.currentTime : 0;
    // keep playing seamlessly while we're ahead; re-buffer only after an underrun
    if (started && ahead > 0.08) flush();
    else if (pendingDur >= LEAD) flush();
  }
  flush();
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, (lastEnd - ac.currentTime) * 1000) + 60));
  playing = false;
  analyser.disconnect();
  if (onLevel) onLevel({ open: 0, wide: 0, round: 0, teeth: 0 });
  if (!out) ac.close();
}

/* Mouth shapes every 20 ms of a chunk of samples, starting at wall-clock time `at`. */
export function envelope(samples, rate, at) {
  const step = 20;
  return { at, step, shapes: window.ZoopeVoice.shapeTrack(samples, rate, step) };
}

export function cancel() { if (engine) engine.cancel(); }
