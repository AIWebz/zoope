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

async function modelsUrl() {
  try {
    const res = await fetch(LOCAL_MODELS + 'manifest.json', { method: 'HEAD', cache: 'no-store' });
    if (res.ok) return { url: LOCAL_MODELS, source: 'local' };
  } catch (e) { /* not self-hosted */ }
  return { url: REMOTE_MODELS, source: 'remote' };
}

/* Loads the model (downloading it the first time). onProgress(fraction, label). */
export function load(onProgress) {
  if (!enginePromise) {
    enginePromise = modelsUrl().then(({ url, source }) => Engine.load({
      language: 'english',
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
  const e = await load(onProgress);
  const input = resample(samples, rate, e.sampleRate);
  const result = await e.clone(input, (stage, p) => {
    if (onProgress && p && p.total) onProgress(p.loaded / p.total, 'Encoding your voice');
  });
  clonedSeconds = result.seconds;
  return result;
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

  // a small lead so the first frames never underrun
  let cursor = ac.currentTime + 0.12;
  // the worker resolves a Float32Array voice to the most recent clone
  for await (const frame of engine.speak(text, new Float32Array(1), { temperature: 0.2 })) {
    const buf = ac.createBuffer(1, frame.length, engine.sampleRate);
    buf.getChannelData(0).set(frame);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(analyser);
    if (cursor < ac.currentTime) cursor = ac.currentTime + 0.02;
    src.start(cursor);
    if (out && out.onEnvelope) out.onEnvelope(envelope(frame, engine.sampleRate, Date.now() + (cursor - ac.currentTime) * 1000));
    cursor += buf.duration;
    lastEnd = cursor;
  }
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
