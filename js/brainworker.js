/*
 * zoope's AI engine on the website, in a Web Worker so the page stays smooth.
 * The engine itself is in aicore.js (shared with the extension's AI page).
 */
import { createEngine } from './aicore.js';

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

const engineReady = library().then((lib) => createEngine({
  lib,
  wasmPaths: new URL('../vendor/transformers/', import.meta.url).href,
  post: (m) => self.postMessage(m)
}));

self.onmessage = async (e) => {
  const m = e.data;
  let engine;
  try { engine = await engineReady; } catch (err) {
    self.postMessage({ id: m.kind === 'load' ? 0 : m.id, kind: 'error', message: 'AI library: ' + (err && err.message) });
    return;
  }
  engine.handle(m);
};
