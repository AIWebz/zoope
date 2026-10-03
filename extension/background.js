/*
 * zoope extension: background service worker.
 *
 * Connects a zoope tab (the "brain": notes, turn-taking, voice) with the
 * meeting tab it opened (the real Zoom, Google Meet or Teams web app). It opens
 * the meeting, keeps the session in session storage (the worker can be
 * restarted at any time), and relays messages between the two tabs.
 */
importScripts('nano.js'); // Chrome's built-in AI (Gemini Nano), when available
const KEY = 'sessions';

async function sessions() { return (await chrome.storage.session.get(KEY))[KEY] || {}; }
async function saveSessions(s) { await chrome.storage.session.set({ [KEY]: s }); }
async function byTab(tabId) {
  const all = await sessions();
  return Object.values(all).find((s) => s.meetingTab === tabId || s.zoopeTab === tabId) || null;
}

function toZoope(s, msg) {
  return chrome.tabs.sendMessage(s.zoopeTab, Object.assign({ sessionId: s.id }, msg)).catch(() => {});
}
function toMeeting(s, msg) {
  // the meeting app may run in frames (Zoom's web client); every frame's script gets it and the right one acts
  return chrome.tabs.sendMessage(s.meetingTab, msg).catch(() => {});
}

/* ------------------------------------------------------------------------------
 * The AI engine installed in the extension (Connect button in the popup).
 * It runs in an offscreen page (ai.html); zoope tabs send requests here, and
 * replies stream back to the tab that asked.
 * ---------------------------------------------------------------------------- */
const AI_KEY = 'aiStatus';
async function aiStatus() {
  const [{ aiConnected }, sess] = await Promise.all([chrome.storage.local.get('aiConnected'), chrome.storage.session.get([AI_KEY, 'aiTabs'])]);
  return Object.assign({ state: 'off', progress: 0 }, sess[AI_KEY] || {}, { connected: !!aiConnected });
}
async function setAiStatus(patch) {
  const st = Object.assign(await aiStatus(), patch);
  delete st.connected;
  await chrome.storage.session.set({ [AI_KEY]: st });
  const full = await aiStatus();
  // tell every zoope tab that has talked to the AI
  const { aiTabs } = await chrome.storage.session.get('aiTabs');
  for (const t of aiTabs || []) chrome.tabs.sendMessage(t, Object.assign({ type: 'aiStatus' }, full)).catch(() => {});
  return full;
}
async function addAiTab(tab) {
  if (tab == null) return;
  const { aiTabs } = await chrome.storage.session.get('aiTabs');
  const list = aiTabs || [];
  if (list.indexOf(tab) < 0) { list.push(tab); await chrome.storage.session.set({ aiTabs: list }); }
}
let engineUp = null;
async function ensureEngine() {
  if (!engineUp) {
    engineUp = (async () => {
      const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
      if (!has) {
        const up = new Promise((resolve) => { pendingUp = resolve; setTimeout(resolve, 5000); });
        await chrome.offscreen.createDocument({ url: 'ai.html', reasons: ['WORKERS'], justification: 'Runs zoope\'s AI engine on this computer.' });
        await up;
      }
    })();
    engineUp.catch(() => { engineUp = null; });
  }
  return engineUp;
}
let pendingUp = null;
async function aiConnect() {
  await chrome.storage.local.set({ aiConnected: true });
  if (await nanoAvailable()) return setAiStatus(NANO);
  const st = await aiStatus();
  const running = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
  if (running && (st.state === 'ready' || st.state === 'loading')) return st;
  await setAiStatus({ state: 'loading', progress: 0, error: '' });
  try {
    await ensureEngine();
    chrome.runtime.sendMessage({ type: 'aiToEngine', msg: { id: 0, kind: 'load' } }).catch(() => {});
  } catch (e) {
    return setAiStatus({ state: 'error', error: e.message });
  }
  return aiStatus();
}
// request ids from different tabs can clash: they travel as "tab:id"
function toTab(m) {
  const o = owner(m.id);
  if (o) chrome.tabs.sendMessage(o.tab, { type: 'aiEngine', msg: Object.assign({}, m, { id: o.id }) }).catch(() => {});
}
// Chrome's built-in AI, run right here in the background, is preferred whenever Chrome has it ready.
const NANO = { state: 'ready', progress: 1, device: 'chrome-ai', model: 'Gemini Nano (built into Chrome)', error: '' };
async function nanoAvailable() { try { return (await self.ZoopeNano.status()) === 'available'; } catch (e) { return false; } }
const owner = (gid) => { const i = String(gid).indexOf(':'); return i < 0 ? null : { tab: +String(gid).slice(0, i), id: +String(gid).slice(i + 1) }; };

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  // ---- from the AI engine page
  if (msg.type === 'aiEngineUp') { if (pendingUp) { pendingUp(); pendingUp = null; } return; }
  if (msg.type === 'aiFromEngine') {
    const m = msg.msg;
    if (m.id === 0) {
      if (m.kind === 'progress') setAiStatus({ state: 'loading', progress: m.total ? m.loaded / m.total : 0 });
      else if (m.kind === 'ready') setAiStatus({ state: 'ready', progress: 1, device: m.device, model: m.model, error: '' });
      else if (m.kind === 'error') setAiStatus({ state: 'error', error: m.message });
      return;
    }
    toTab(m);
    return;
  }
  if (msg.type === 'aiToEngine') return; // meant for the engine page

  (async () => {
    const tab = sender.tab && sender.tab.id;
    switch (msg && msg.type) {
      // ---- from the zoope tab
      case 'join': {
        const t = await chrome.tabs.create({ url: msg.url, active: true });
        // the zoope tab runs the call from the background: don't let Chrome discard either tab
        chrome.tabs.update(tab, { autoDiscardable: false }).catch(() => {});
        chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
        const id = 'z' + Date.now().toString(36);
        const all = await sessions();
        all[id] = {
          id, zoopeTab: tab, meetingTab: t.id, platform: msg.platform, name: msg.name,
          title: msg.title || '', portrait: msg.portrait || null, started: Date.now(), state: 'opening'
        };
        await saveSessions(all);
        return { ok: true, sessionId: id };
      }
      case 'toMeeting': {
        const s = (await sessions())[msg.sessionId];
        if (!s) return { ok: false, error: 'No such meeting' };
        await toMeeting(s, msg.msg);
        return { ok: true };
      }
      case 'focusMeeting': {
        const s = (await sessions())[msg.sessionId];
        if (s) await chrome.tabs.update(s.meetingTab, { active: true }).catch(() => {});
        return { ok: !!s };
      }
      case 'end': {
        const all = await sessions();
        delete all[msg.sessionId];
        await saveSessions(all);
        return { ok: true };
      }
      case 'ping':
        return { ok: true, version: chrome.runtime.getManifest().version };

      // ---- the AI engine (popup and zoope tabs)
      case 'aiStatus': {
        await addAiTab(tab);
        const st = await aiStatus();
        // Chrome's built-in AI became available (e.g. its download finished): switch to it
        if (st.connected && st.device !== 'chrome-ai' && await nanoAvailable()) return setAiStatus(NANO);
        // installed earlier: start it again (from the extension's storage, no download) when zoope asks
        if (st.connected && st.device !== 'chrome-ai' && (st.state === 'off' || !(await chrome.offscreen.hasDocument()))) return aiConnect();
        return st;
      }
      case 'aiConnect':
        await addAiTab(tab);
        return aiConnect();
      case 'aiAsk': {
        await addAiTab(tab);
        if (await nanoAvailable()) {
          const st = await aiStatus();
          if (st.device !== 'chrome-ai') await setAiStatus(NANO);
          self.ZoopeNano.ask(tab + ':' + msg.id, msg.messages, toTab);
          return { ok: true };
        }
        await ensureEngine();
        chrome.runtime.sendMessage({ type: 'aiToEngine', msg: { id: tab + ':' + msg.id, kind: 'ask', messages: msg.messages, maxTokens: msg.maxTokens } }).catch(() => {});
        return { ok: true };
      }
      case 'aiWarm':
        // get Chrome's AI ready for this meeting's replies ahead of time
        if (await nanoAvailable()) self.ZoopeNano.warm(msg.system).catch(() => {});
        return { ok: true };
      case 'aiGarbled':
        // a zoope tab saw broken output: the engine moves to its next mode
        await setAiStatus({ state: 'loading', progress: 1, error: '' });
        chrome.runtime.sendMessage({ type: 'aiToEngine', msg: { id: 0, kind: 'garbled' } }).catch(() => {});
        return { ok: true };
      case 'aiStop':
        self.ZoopeNano.stop(tab + ':' + msg.id);
        chrome.runtime.sendMessage({ type: 'aiToEngine', msg: { id: tab + ':' + msg.id, kind: 'stop' } }).catch(() => {});
        return { ok: true };

      // ---- from the meeting tab
      case 'hello': {
        const s = await byTab(tab);
        if (!s || s.meetingTab !== tab) return { session: null };
        return { session: { id: s.id, platform: s.platform, name: s.name, title: s.title, portrait: s.portrait } };
      }
      case 'toZoope': {
        const s = await byTab(tab);
        if (!s || s.meetingTab !== tab) return { ok: false };
        if (msg.msg && msg.msg.type === 'status') {
          const all = await sessions();
          if (all[s.id]) { all[s.id].state = msg.msg.state; await saveSessions(all); }
        }
        await toZoope(s, msg.msg);
        return { ok: true };
      }
    }
    return { ok: false, error: 'Unknown message' };
  })().then(reply);
  return true; // async reply
});

// a closed meeting tab ends the meeting; a closed zoope tab makes the avatar leave
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await byTab(tabId);
  if (!s) return;
  if (s.meetingTab === tabId) {
    await toZoope(s, { type: 'status', state: 'left', reason: 'The meeting tab was closed.' });
    const all = await sessions();
    delete all[s.id];
    await saveSessions(all);
  } else {
    await toMeeting(s, { type: 'leave', reason: 'zoope was closed' });
  }
});
