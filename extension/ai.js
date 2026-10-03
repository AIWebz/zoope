/*
 * zoope extension: the AI engine, installed into the extension.
 *
 * Runs in a hidden (offscreen) extension page. The model downloads into the
 * extension's own storage the first time the user presses Connect, and is
 * loaded from there afterwards. zoope tabs send their requests through the
 * extension's background worker, which relays them here.
 */
import * as lib from './lib/ai/transformers.min.js';
import './nano.js'; // Chrome's built-in AI, preferred when this page can use it
import { createEngine } from './lib/ai/aicore.js';

const engine = createEngine({
  lib,
  wasmPaths: chrome.runtime.getURL('lib/ai/'),
  post: (msg) => chrome.runtime.sendMessage({ type: 'aiFromEngine', msg }).catch(() => {})
});

const post = (msg) => chrome.runtime.sendMessage({ type: 'aiFromEngine', msg }).catch(() => {});
let useNano = false;
async function handle(m) {
  if (m.kind === 'load') {
    if (await self.ZoopeNano.status() === 'available') {
      useNano = true;
      post({ id: 0, kind: 'ready', device: 'chrome-ai', model: 'Gemini Nano (built into Chrome)' });
      return;
    }
    return engine.handle(m);
  }
  if (useNano && m.kind === 'ask') return self.ZoopeNano.ask(m.id, m.messages, post);
  if (useNano && m.kind === 'stop') return self.ZoopeNano.stop(m.id);
  if (useNano && m.kind === 'garbled') { useNano = false; return engine.handle({ id: 0, kind: 'load' }); }
  return engine.handle(m);
}
chrome.runtime.onMessage.addListener((m) => {
  if (m && m.type === 'aiToEngine') handle(m.msg);
});
chrome.runtime.sendMessage({ type: 'aiEngineUp' }).catch(() => {});
