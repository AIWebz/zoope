/*
 * zoope's AI engine core, shared by the website's worker (brainworker.js) and the
 * extension's AI page (extension/ai.js).
 *
 * Runs an instruction-tuned model (Qwen2.5 0.5B Instruct, 4-bit) with transformers.js:
 * GPU (WebGPU) when available, otherwise CPU (WebAssembly). Weights come from Hugging
 * Face (or its mirror) once and are cached.
 *
 * Messages in:  { id, kind: 'load' } | { id, kind: 'ask', messages, maxTokens } | { id, kind: 'stop' }
 *               | { id: 0, kind: 'garbled' } (the page saw broken output: switch to the next mode)
 * Messages out: { id: 0, kind: 'progress' | 'ready' | 'error' } and { id, kind: 'token' | 'done' | 'error' }
 */
const SMALL = 'onnx-community/Qwen2.5-0.5B-Instruct';
const HOSTS = ['https://huggingface.co/', 'https://hf-mirror.com/'];

/*
 * Is this text broken output rather than language? A healthy model writes sentences; a broken
 * backend (bad numerics on some GPUs) produces word salad such as "Talk Talk Did Talk Listen"
 * or "SplitsSentencesByFriday": words glued together, every word capitalised, one word over and
 * over, giant "words", or a long run without any punctuation.
 */
export function garbled(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const w = t.split(/\s+/).filter(Boolean);
  const camel = w.filter((x) => /[a-z][A-Z]/.test(x)).length;
  const caps = w.slice(1).filter((x) => /^[A-Z][a-z]/.test(x)).length;
  const counts = {};
  let top = 0;
  for (const x of w) {
    const k = x.toLowerCase().replace(/[^a-z0-9']/g, '');
    if (!k || /^(the|a|an|to|and|i|you|it|of|is|that|in|we|on|for|so)$/.test(k)) continue;
    counts[k] = (counts[k] || 0) + 1;
    top = Math.max(top, counts[k]);
  }
  const longest = Math.max(...w.map((x) => x.replace(/[^A-Za-z]/g, '').length));
  return camel >= 2 || camel / w.length > 0.15 ||
    (w.length >= 8 && caps / (w.length - 1) > 0.75) ||
    (w.length >= 8 && top / w.length > 0.25) ||
    longest > 22 ||
    (w.length >= 30 && !/[.!?,;:]/.test(t));
}

export function createEngine({ lib, wasmPaths, post }) {
  const { pipeline, env, TextStreamer } = lib;
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = wasmPaths;
  let gen = null, current = null, loading = null, plans = [], planIndex = -1;

  async function tryLoad(plan, progress) {
    let lastErr = null;
    for (const host of HOSTS) {
      try {
        env.remoteHost = host;
        gen = await pipeline('text-generation', plan.model, { dtype: plan.dtype, device: plan.device, progress_callback: progress });
        current = plan;
        return null;
      } catch (err) {
        lastErr = err;
        // only a network failure is worth retrying from the mirror
        if (!/fetch|network/i.test(String(err && err.message))) break;
      }
    }
    return lastErr;
  }

  // Self-test after loading: a mode that can't answer "2 plus 2" in plain language is broken on this computer.
  async function selfTest() {
    const out = await gen([{ role: 'user', content: 'What is 2 plus 2? Answer in one short sentence.' }], { max_new_tokens: 20, do_sample: false });
    const last = out[0].generated_text;
    const text = Array.isArray(last) ? last[last.length - 1].content : String(last);
    if (garbled(text) || !/\b(4|four)\b/i.test(text)) throw new Error('self-test failed (' + text.slice(0, 60) + ')');
  }

  // Loads the first mode, from `from` on, that loads and passes the self-test.
  async function loadFrom(from, progress) {
    let lastErr = null;
    for (let i = from; i < plans.length; i++) {
      const plan = plans[i];
      if (gen && gen.dispose) { try { await gen.dispose(); } catch (e) { /* already freed */ } }
      gen = null;
      if (plan.oneThread) env.backends.onnx.wasm.numThreads = 1;
      lastErr = await tryLoad(plan, progress);
      if (!lastErr) {
        try { await selfTest(); } catch (err) { lastErr = err; gen = null; continue; }
        planIndex = i;
        post({ id: 0, kind: 'ready', device: current.device, model: current.model, dtype: current.dtype });
        return;
      }
    }
    throw new Error('model: ' + (lastErr && lastErr.message));
  }

  async function load() {
    if (gen) { post({ id: 0, kind: 'ready', device: current.device, model: current.model, dtype: current.dtype }); return; }
    const webgpu = !!(self.navigator && navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null));
    const progress = (p) => { if (p && p.status === 'progress' && p.total) post({ id: 0, kind: 'progress', loaded: p.loaded, total: p.total, file: p.file }); };
    // 4-bit weights with full-precision outputs everywhere (half-precision outputs garbled replies on some
    // computers): GPU, then CPU multi-threaded, then CPU on one thread
    plans = [];
    if (webgpu) plans.push({ model: SMALL, device: 'webgpu', dtype: 'q4' });
    plans.push({ model: SMALL, device: 'wasm', dtype: 'q4' }, { model: SMALL, device: 'wasm', dtype: 'q4', oneThread: true });
    await loadFrom(0, progress);
  }

  // The page saw garbled output: move to the next mode (and say so with a new 'ready', or an error).
  async function nextMode() { await loadFrom(planIndex + 1); }

  // one generation at a time (the model can't run two at once); later requests wait their turn
  let queue = Promise.resolve();
  const stopped = new Set();
  function ask(id, messages, maxTokens) {
    const run = queue.then(() => askNow(id, messages, maxTokens));
    queue = run.catch(() => {});
    return run;
  }
  async function askNow(id, messages, maxTokens) {
    if (!gen) throw new Error('the model is not loaded');
    if (stopped.has(id)) { stopped.delete(id); post({ id, kind: 'done' }); return; }
    const streamer = new TextStreamer(gen.tokenizer, {
      skip_prompt: true, skip_special_tokens: true,
      callback_function: (text) => { if (stopped.has(id)) throw new Error('__stop'); post({ id, kind: 'token', text }); }
    });
    const opts = { max_new_tokens: maxTokens || 60, do_sample: true, temperature: 0.75, top_p: 0.9, repetition_penalty: 1.1, streamer };
    try {
      await gen(messages, opts);
    } catch (err) {
      if (/__stop/.test(String(err && err.message))) { /* stopped on purpose */ }
      else if (planIndex + 1 < plans.length) {
        // this mode fails when generating on this computer: move to the next one and answer there
        await nextMode();
        try { await gen(messages, opts); } catch (e2) { if (!/__stop/.test(String(e2 && e2.message))) throw e2; }
      } else throw err;
    }
    stopped.delete(id);
    post({ id, kind: 'done' });
  }

  return {
    async handle(m) {
      try {
        if (m.kind === 'load') { loading = loading || load().finally(() => { loading = null; }); await loading; }
        else if (m.kind === 'ask') await ask(m.id, m.messages, m.maxTokens);
        else if (m.kind === 'stop') stopped.add(m.id);
        else if (m.kind === 'garbled') { loading = loading || nextMode().finally(() => { loading = null; }); await loading; }
      } catch (err) {
        post({ id: m.kind === 'load' ? 0 : m.id, kind: 'error', message: err && err.message ? err.message : String(err), stack: err && err.stack ? String(err.stack).slice(0, 1500) : '' });
      }
    }
  };
}
