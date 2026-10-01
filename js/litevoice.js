/*
 * Light voice, on-device, for every device.
 *
 * The neural voice clone needs a 216 MB model and about 1 GB of memory, which
 * many phones can't give a browser tab. The light voice is made from the same
 * voice scan with a small speech synthesizer (eSpeak NG, 18 MB, a few MB of
 * memory): zoope tunes its pitch and speaking pace to the ones measured in your
 * recording, then builds a filter that gives it the tone of your voice (the
 * long-term spectrum of your recording versus the synthesizer's reading of the
 * same passage). It sounds synthetic, not like a recording of you, but it is
 * tuned to you and works everywhere.
 */
import factory from '../vendor/espeak-ng/espeak-ng.js';

const WASM = new URL('../vendor/espeak-ng/espeak-ng.wasm', import.meta.url).href;
const PASSAGE = "Hi everyone, thanks for having me. Quick update on the redesign: we're on track, the checkout page is nearly finished, and I'll send notes after the call. Let me know if you have any questions.";
let binP = null, modP = null;
/* Compiled once and reused: compiling 18 MB of WebAssembly per reply would add a noticeable delay. */
function compiled() {
  if (!modP) { modP = wasm().then((b) => WebAssembly.compile(b)); modP.catch(() => { modP = null; }); }
  return modP;
}
export function warm() { return compiled().then(() => true).catch(() => false); }
function wasm() {
  if (!binP) {
    binP = fetch(WASM).then((r) => { if (!r.ok) throw new Error(r.status + ' loading the speech synthesizer'); return r.arrayBuffer(); })
      .then((b) => new Uint8Array(b));
    binP.catch(() => { binP = null; });
  }
  return binP;
}

/* Text to speech samples with eSpeak NG. */
export async function synth(text, v) {
  const mod = await compiled();
  const clean = String(text).replace(/\s+/g, ' ').trim() || '.';
  const es = await factory({
    instantiateWasm: (imports, done) => { WebAssembly.instantiate(mod, imports).then((inst) => done(inst, mod)); return {}; },
    arguments: ['-w', 'out.wav', '-v', v.voice, '-p', String(v.pitch), '-s', String(v.speed), '-a', '130', '-g', '2', clean.startsWith('-') ? ' ' + clean : clean],
    print: () => {}, printErr: () => {}
  });
  const wav = es.FS.readFile('out.wav');
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const rate = dv.getUint32(24, true);
  // find the data chunk
  let off = 12;
  while (off + 8 <= wav.length && String.fromCharCode(wav[off], wav[off + 1], wav[off + 2], wav[off + 3]) !== 'data') off += 8 + dv.getUint32(off + 4, true);
  const n = Math.max(0, Math.min(dv.getUint32(off + 4, true), wav.length - off - 8) >> 1), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(off + 8 + i * 2, true) / 32768;
  // trim the synthesizer's silence at both ends, so replies start right away
  let a = 0, b = out.length;
  while (a < b && Math.abs(out[a]) < 0.004) a++;
  while (b > a && Math.abs(out[b - 1]) < 0.004) b--;
  const pad = Math.round(rate * 0.03);
  return { samples: out.subarray(Math.max(0, a - pad), Math.min(out.length, b + pad)), rate };
}

// ---------- tone matching: long-term average spectrum in log bands ----------
const BANDS = [];
for (let f = 120; f < 8000; f *= 1.26) BANDS.push(f); // third-octave-ish bands
function ltas(samples, rate) {
  const N = 1024, acc = new Float64Array(BANDS.length), V = window.ZoopeVoice;
  let frames = 0;
  // only frames with real energy (speech, not pauses)
  let peak = 0;
  for (let i = 0; i < samples.length; i += 64) peak = Math.max(peak, Math.abs(samples[i]));
  for (let s = 0; s + N <= samples.length; s += N / 2) {
    const fr = samples.subarray(s, s + N);
    let e = 0;
    for (let i = 0; i < N; i += 4) e += fr[i] * fr[i];
    if (Math.sqrt(e / (N / 4)) < peak * 0.08) continue;
    const mag = V.spectrum(fr);
    for (let b = 0; b < BANDS.length; b++) {
      const lo = Math.floor(BANDS[b] / 1.12 * N / rate), hi = Math.max(lo + 1, Math.ceil(BANDS[b] * 1.12 * N / rate));
      let p = 0;
      for (let k = lo; k < hi && k < mag.length; k++) p += mag[k] * mag[k];
      acc[b] += p / (hi - lo);
    }
    frames++;
  }
  return Array.from(acc, (v) => v / Math.max(1, frames));
}
function eqGains(user, synthL) {
  let g = user.map((u, i) => Math.sqrt((u + 1e-9) / (synthL[i] + 1e-9)));
  // smooth across neighbouring bands, normalise to unit mean, and keep within ±12 dB
  g = g.map((_, i) => (g[Math.max(0, i - 1)] + 2 * g[i] + g[Math.min(g.length - 1, i + 1)]) / 4);
  const logMean = g.reduce((s, v) => s + Math.log(v), 0) / g.length;
  return g.map((v) => Math.round(Math.min(4, Math.max(0.25, v / Math.exp(logMean))) * 1000) / 1000);
}
/* Linear-phase FIR from band gains (frequency sampling, Hann window). */
function fir(gains, rate, taps = 255) {
  const M = taps, h = new Float32Array(M), half = (M - 1) / 2, K = 256;
  const H = new Float64Array(K + 1);
  for (let k = 0; k <= K; k++) {
    const f = k / K * rate / 2;
    let g;
    if (f <= BANDS[0]) g = gains[0];
    else if (f >= BANDS[BANDS.length - 1]) g = gains[gains.length - 1];
    else {
      const x = Math.log(f / BANDS[0]) / Math.log(1.26), i = Math.floor(x), t = x - i;
      g = gains[i] * (1 - t) + gains[Math.min(gains.length - 1, i + 1)] * t;
    }
    H[k] = g;
  }
  for (let n = 0; n < M; n++) {
    let s = H[0];
    for (let k = 1; k < K; k++) s += 2 * H[k] * Math.cos(Math.PI * k * (n - half) / K);
    s += H[K] * Math.cos(Math.PI * (n - half));
    h[n] = s / (2 * K) * (0.5 - 0.5 * Math.cos(2 * Math.PI * n / (M - 1)));
  }
  return h;
}
function convolve(x, h) {
  const y = new Float32Array(x.length), M = h.length, half = (M - 1) >> 1;
  for (let n = 0; n < x.length; n++) {
    let s = 0;
    const k0 = Math.max(0, n + half - x.length + 1), k1 = Math.min(M, n + half + 1);
    for (let k = k0; k < k1; k++) s += h[k] * x[n + half - k];
    y[n] = s;
  }
  // keep the level comfortable
  let peak = 0;
  for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
  if (peak > 0.95) for (let i = 0; i < y.length; i++) y[i] *= 0.95 / peak;
  return y;
}

/*
 * Makes the light voice from the voice scan: the recording (mono samples at
 * `rate`) and its measured profile. Returns plain data to store.
 */
export async function make(samples, rate, profile, onProgress) {
  const V = window.ZoopeVoice, step = (f, l) => onProgress && onProgress(f, l);
  step(0.05, 'Loading the speech synthesizer');
  await wasm();
  const voice = profile.pitchHz >= 165 ? 'en-us+f3' : 'en-us';
  // pitch: espeak's 0–99 scale is close to linear in Hz; measure two points and aim for the user's median
  step(0.3, 'Matching your pitch');
  const measure = async (v) => { const r = await synth(PASSAGE, v); return { r, a: V.analyzeSamples(r.samples, r.rate) }; };
  const lo = await measure({ voice, pitch: 25, speed: 170 }), hi = await measure({ voice, pitch: 85, speed: 170 });
  let pitch = 50;
  if (lo.a.ok && hi.a.ok && hi.a.pitchHz !== lo.a.pitchHz) {
    pitch = 25 + (profile.pitchHz - lo.a.pitchHz) * 60 / (hi.a.pitchHz - lo.a.pitchHz);
  }
  pitch = Math.round(Math.max(0, Math.min(99, pitch)));
  // pace: words per minute scaled so the syllable rate matches the user's
  step(0.55, 'Matching your pace');
  const mid = await measure({ voice, pitch, speed: 170 });
  let speed = 170;
  if (mid.a.ok && mid.a.pace > 0 && profile.pace > 0) speed = 170 * profile.pace / mid.a.pace;
  speed = Math.round(Math.max(110, Math.min(260, speed)));
  // tone: the synthesizer's reading of the passage versus the user's
  step(0.8, 'Matching your tone');
  const ref = await synth(PASSAGE, { voice, pitch, speed });
  const gains = eqGains(ltas(samples, rate), ltas(ref.samples, ref.rate));
  step(1, 'Done');
  return { kind: 'lite', voice, pitch, speed, gains, made: Date.now() };
}

let filterCache = null;
/* Synthesizes text in the light voice: samples at the synthesizer's rate. */
export async function render(text, v) {
  const r = await synth(text, v);
  if (!filterCache || filterCache.key !== v.made + ':' + r.rate) filterCache = { key: v.made + ':' + r.rate, h: fir(v.gains, r.rate) };
  return { samples: convolve(r.samples, filterCache.h), rate: r.rate };
}

/*
 * Speaks text in the light voice. onLevel(shape) drives the mouth;
 * out: { context, destination, onEnvelope } sends it into a meeting instead.
 */
export async function speak(text, v, onLevel, out) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = out ? out.context : new AC();
  await ac.resume();
  // the whole reply in one pass, so it flows without gaps between sentences
  const { samples, rate } = await render(text, v);
  const buf = ac.createBuffer(1, samples.length, rate);
  buf.getChannelData(0).set(samples);
  const last = ac.createBufferSource();
  last.buffer = buf;
  last.connect(out ? out.destination : ac.destination);
  const startAt = ac.currentTime + 0.03;
  const shapes = window.ZoopeVoice.shapeTrack(samples, rate, 20);
  if (out && out.onEnvelope) out.onEnvelope({ at: Date.now() + 30, step: 20, shapes });
  // lips lead the sound by ~50 ms, as in real speech
  let playing = true;
  (function tick() {
    if (!playing) return;
    const i = Math.floor((ac.currentTime + 0.05 - startAt) / 0.02), v = i >= 0 && i < shapes.length ? shapes[i] : null;
    if (onLevel) onLevel(v ? { open: v[0], wide: v[1], round: v[2], teeth: v[3] } : { open: 0, wide: 0, round: 0, teeth: 0 });
    requestAnimationFrame(tick);
  })();
  last.start(startAt);
  await new Promise((resolve) => { last.onended = resolve; });
  playing = false;
  if (onLevel) onLevel({ open: 0, wide: 0, round: 0, teeth: 0 });
  if (!out) ac.close();
}
