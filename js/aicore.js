/*
 * zoope's AI engine core, shared by the website's worker (brainworker.js) and the
 * extension's AI page (extension/ai.js).
 *
 * Runs an instruction-tuned model (Qwen2.5 0.5B Instruct, 4-bit) with transformers.js:
 * GPU (WebGPU) when available, otherwise CPU (WebAssembly). Weights come from Hugging
 * Face (or its mirror) once and are cached.
 *
 * Messages in:  { id, kind: 'load' } | { id, kind: 'ask', messages, maxTokens } | { id, kind: 'stop' }
 * Messages out: { id: 0, kind: 'progress' | 'ready' | 'error' } and { id, kind: 'token' | 'done' | 'error' }
 */
const SMALL = 'onnx-community/Qwen2.5-0.5B-Instruct';
const HOSTS = ['https://huggingface.co/', 'https://hf-mirror.com/'];

export function createEngine({ lib, wasmPaths, post }) {
  const { pipeline, env, TextStreamer } = lib;
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = wasmPaths;
  let gen = null, current = null, fellBack = false, loading = null;

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

  async function load() {
    if (gen) { post({ id: 0, kind: 'ready', device: current.device, model: current.model }); return; }
    const webgpu = !!(self.navigator && navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null));
    const progress = (p) => { if (p && p.status === 'progress' && p.total) post({ id: 0, kind: 'progress', loaded: p.loaded, total: p.total, file: p.file }); };
    // best first: GPU half precision (needs shader-f16), GPU full precision, CPU multi-threaded, CPU one thread
    const plans = [];
    if (webgpu) plans.push({ model: SMALL, device: 'webgpu', dtype: 'q4f16' }, { model: SMALL, device: 'webgpu', dtype: 'q4' });
    plans.push({ model: SMALL, device: 'wasm', dtype: 'q4' }, { model: SMALL, device: 'wasm', dtype: 'q4', oneThread: true });
    let lastErr = null;
    for (const plan of plans) {
      if (plan.oneThread) env.backends.onnx.wasm.numThreads = 1;
      lastErr = await tryLoad(plan, progress);
      if (!lastErr) {
        post({ id: 0, kind: 'ready', device: current.device, model: current.model });
        ask('warm-up', [{ role: 'user', content: 'Say hi.' }], 4).catch(() => {}); // compile once, so the first real reply is quick
        return;
      }
    }
    throw new Error('model: ' + (lastErr && lastErr.message));
  }

  // Some GPUs load the model but fail when generating: switch to the CPU model for good.
  async function cpuFallback() {
    fellBack = true;
    if (await tryLoad({ model: SMALL, device: 'wasm', dtype: 'q4' })) return false;
    post({ id: 0, kind: 'ready', device: 'wasm', model: SMALL });
    return true;
  }

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
    const opts = { max_new_tokens: maxTokens || 60, do_sample: true, temperature: 0.7, top_p: 0.9, repetition_penalty: 1.1, streamer };
    try {
      await gen(messages, opts);
    } catch (err) {
      if (/__stop/.test(String(err && err.message))) { /* stopped on purpose */ }
      else if (current && current.device === 'webgpu' && !fellBack && await cpuFallback()) {
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
      } catch (err) {
        post({ id: m.kind === 'load' ? 0 : m.id, kind: 'error', message: err && err.message ? err.message : String(err), stack: err && err.stack ? String(err.stack).slice(0, 1500) : '' });
      }
    }
  };
}
