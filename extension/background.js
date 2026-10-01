/*
 * zoope extension: background service worker.
 *
 * Connects a zoope tab (the "brain": notes, turn-taking, voice) with the
 * meeting tab it opened (the real Zoom, Google Meet or Teams web app). It opens
 * the meeting, keeps the session in session storage (the worker can be
 * restarted at any time), and relays messages between the two tabs.
 */
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

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const tab = sender.tab && sender.tab.id;
    switch (msg && msg.type) {
      // ---- from the zoope tab
      case 'join': {
        const t = await chrome.tabs.create({ url: msg.url, active: true });
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
