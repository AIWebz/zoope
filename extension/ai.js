/*
 * zoope extension: the AI engine, installed into the extension.
 *
 * Runs in a hidden (offscreen) extension page. The model downloads into the
 * extension's own storage the first time the user presses Connect, and is
 * loaded from there afterwards. zoope tabs send their requests through the
 * extension's background worker, which relays them here.
 */
import * as lib from './lib/ai/transformers.min.js';
import { createEngine } from './lib/ai/aicore.js';

const engine = createEngine({
  lib,
  wasmPaths: chrome.runtime.getURL('lib/ai/'),
  post: (msg) => chrome.runtime.sendMessage({ type: 'aiFromEngine', msg }).catch(() => {})
});

chrome.runtime.onMessage.addListener((m) => {
  if (m && m.type === 'aiToEngine') engine.handle(m.msg);
});
chrome.runtime.sendMessage({ type: 'aiEngineUp' }).catch(() => {});
