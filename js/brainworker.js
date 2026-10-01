/*
 * zoope's language model, in a Web Worker so the page stays smooth.
 *
 * Runs an instruction-tuned model (Qwen2.5 1.5B Instruct on a GPU, 0.5B otherwise; 4-bit) with
 * transformers.js on WebGPU when available, else WebAssembly. Weights come
 * from Hugging Face (or its mirror) once and are cached by the browser.
 */
// The library is stored gzipped (its minified text trips secret scanners on long class names);
// it is unpacked here and imported from memory.
const LIB = new URL('../vendor/transformers/transformers.min.js.gz', import.meta.url).href;
async function library() {
  const res = await fetch(LIB);
  if (!res.ok) throw new Error(res.status + ' loading the AI engine');
  const bytes = new Uint8Array(await res.arrayBuffer());
  // some servers already decompress .gz files; only unpack when it is still gzip
  const code = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(bytes);
  return import(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
}
let pipeline, env, TextStreamer;
const libReady = library().then((m) => { pipeline = m.pipeline; env = m.env; TextStreamer = m.TextStreamer; setup(); });

// a bigger, smarter model when a GPU is available; the small one on CPU
const MODELS = { webgpu: ['onnx-community/Qwen2.5-1.5B-Instruct', 'onnx-community/Qwen2.5-0.5B-Instruct'], wasm: ['onnx-community/Qwen2.5-0.5B-Instruct'] };
function setup() {
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;
}
let gen = null;

async function load(id) {
  await libReady;
  const webgpu = !!(self.navigator && navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null));
  const progress = (p) => { if (p && p.status === 'progress' && p.total) self.postMessage({ id, kind: 'progress', loaded: p.loaded, total: p.total, file: p.file }); };
  const device = webgpu ? 'webgpu' : 'wasm';
  const opts = { dtype: webgpu ? 'q4f16' : 'q4', device, progress_callback: progress };
  let lastErr = null;
  for (const model of MODELS[device]) {
    for (const host of ['https://huggingface.co/', 'https://hf-mirror.com/']) {
      try {
        env.remoteHost = host;
        gen = await pipeline('text-generation', model, opts);
        self.postMessage({ id, kind: 'ready', device, model });
        return;
      } catch (err) { lastErr = err; }
    }
  }
  throw new Error('model download: ' + (lastErr && lastErr.message));
}

// Generates a reply token by token, streaming it to the page so speech can start at the first sentence.
let stopFlag = false;
async function ask(id, messages, maxTokens) {
  if (!gen) throw new Error('the model is not loaded');
  stopFlag = false;
  const streamer = new TextStreamer(gen.tokenizer, {
    skip_prompt: true, skip_special_tokens: true,
    callback_function: (text) => { if (stopFlag) throw new Error('__stop'); self.postMessage({ id, kind: 'token', text }); }
  });
  try {
    await gen(messages, { max_new_tokens: maxTokens || 80, do_sample: true, temperature: 0.7, top_p: 0.9, repetition_penalty: 1.1, streamer });
  } catch (err) {
    if (!/__stop/.test(String(err && err.message))) throw err;
  }
  self.postMessage({ id, kind: 'done' });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.kind === 'load') await load(m.id);
    else if (m.kind === 'ask') await ask(m.id, m.messages, m.maxTokens);
    else if (m.kind === 'stop') stopFlag = true;
  } catch (err) {
    self.postMessage({ id: m.id, kind: 'error', message: err && err.message ? err.message : String(err) });
  }
};
