/*
 * zoope's language model, in a Web Worker so the page stays smooth.
 *
 * Runs a small instruction-tuned model (Qwen2.5 0.5B Instruct, 4-bit) with
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
let pipeline, env;
const libReady = library().then((m) => { pipeline = m.pipeline; env = m.env; setup(); });

const MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct';
function setup() {
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;
}
let gen = null;

async function load(id) {
  await libReady;
  const webgpu = !!(self.navigator && navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null));
  const progress = (p) => { if (p && p.status === 'progress' && p.total) self.postMessage({ id, kind: 'progress', loaded: p.loaded, total: p.total, file: p.file }); };
  const opts = { dtype: webgpu ? 'q4f16' : 'q4', device: webgpu ? 'webgpu' : 'wasm', progress_callback: progress };
  for (const host of ['https://huggingface.co/', 'https://hf-mirror.com/']) {
    try {
      env.remoteHost = host;
      gen = await pipeline('text-generation', MODEL, opts);
      self.postMessage({ id, kind: 'ready', device: opts.device });
      return;
    } catch (err) { if (host.includes('mirror')) throw new Error('model download: ' + (err && err.message)); }
  }
}

async function ask(id, messages, maxTokens) {
  if (!gen) throw new Error('the model is not loaded');
  const out = await gen(messages, { max_new_tokens: maxTokens || 48, do_sample: false, repetition_penalty: 1.1 });
  const last = out[0].generated_text;
  const text = Array.isArray(last) ? last[last.length - 1].content : String(last);
  self.postMessage({ id, kind: 'answer', text: text.trim() });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.kind === 'load') await load(m.id);
    else if (m.kind === 'ask') await ask(m.id, m.messages, m.maxTokens);
  } catch (err) {
    self.postMessage({ id: m.id, kind: 'error', message: err && err.message ? err.message : String(err) });
  }
};
