/*
 * zoope extension: runs in the meeting tab (extension world).
 *
 * Only acts in a tab that zoope opened. It gets the avatar through the
 * pre-join screen with the user's name, turns on captions, reads them and
 * sends each finished line (with the speaker's name) to zoope, posts in the
 * chat when asked, leaves when asked, and reports when the meeting ends.
 * It also renders the live avatar for the page's camera, moving its mouth in
 * time with the voice zoope sends.
 */
(() => {
  if (window.__zoopeMeeting) return;
  window.__zoopeMeeting = true;
  const P = window.ZoopePlatforms && window.ZoopePlatforms.detect(location);
  if (!P) return;
  const U = window.ZoopePlatforms.util;
  const top = window === window.top;

  const hello = chrome.runtime.sendMessage({ type: 'hello' }).then((r) => (r && r.session) || null).catch(() => null);
  const send = (msg) => chrome.runtime.sendMessage({ type: 'toZoope', msg }).catch(() => {});
  const toPage = (type, data, id) => window.postMessage({ __zoope: 'to-page', type, data, id }, '*');

  // ---- requests from the page script in this frame
  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__zoope !== 'to-ext') return;
    if (d.type === 'active') { const s = await hello; toPage('reply', { active: !!s }, d.id); }
    else if (d.type === 'canvas') toPage('reply', await avatarCanvas(), d.id);
    else if (d.type === 'signal') send({ type: 'signal', data: d.data });
    else if (d.type === 'log') send({ type: 'log', text: String(d.data) });
  });

  // ---- the avatar, drawn into a canvas the page turns into its camera
  const LAG = 40; // ms: WebRTC delay on the voice, minus the lips' natural lead
  let envelopes = [];
  const REST = { open: 0, wide: 0, round: 0, teeth: 0 };
  function mouthLevel() {
    const now = Date.now() - LAG;
    envelopes = envelopes.filter((e) => e.at + (e.shapes || e.levels).length * e.step > now - 1000);
    for (const e of envelopes) {
      const i = Math.floor((now - e.at) / e.step), list = e.shapes || e.levels;
      if (i < 0 || i >= list.length) continue;
      const v = list[i];
      return Array.isArray(v) ? { open: v[0], wide: v[1], round: v[2], teeth: v[3] } : { open: v, wide: 0, round: 0, teeth: 0 };
    }
    return REST;
  }
  let canvasP = null;
  function avatarCanvas() {
    if (canvasP) return canvasP;
    canvasP = (async () => {
      const s = await hello;
      const c = document.createElement('canvas');
      c.id = 'zoope-avatar-' + Math.random().toString(36).slice(2, 8);
      c.width = 1280; c.height = 720;
      c.setAttribute('aria-hidden', 'true');
      c.style.cssText = 'position:fixed;left:-20000px;top:0;width:640px;height:360px;pointer-events:none;';
      (document.body || document.documentElement).appendChild(c);
      let rendered = false;
      if (s && s.portrait) {
        try {
          const m = await import(chrome.runtime.getURL('lib/portrait.js'));
          if (m.supported()) {
            await new Promise((resolve, reject) => {
              m.attach(c, { portrait: s.portrait }, mouthLevel, { direct: true, size: [1280, 720], frame: 'bust', onReady: resolve, onError: reject });
            });
            rendered = true;
          }
        } catch (err) { send({ type: 'log', text: 'avatar: ' + err.message }); }
      }
      if (!rendered) placeholder(c, s ? s.name : 'zoope');
      return { id: c.id, label: (s && s.name) || 'zoope' };
    })();
    return canvasP;
  }
  // no scanned face: the user's initial, still producing frames so the stream stays alive
  function placeholder(c, name) {
    const ctx = c.getContext('2d');
    const draw = () => {
      ctx.fillStyle = '#18181b'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#0b5cff'; ctx.beginPath(); ctx.arc(640, 330, 120 + mouthLevel().open * 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 120px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(name || '?').charAt(0).toUpperCase(), 640, 336);
      setTimeout(draw, 1000 / 15);
    };
    draw();
  }

  // ---- captions: a line is finished when its text stops changing
  const lines = new Map();
  let selfNames = [];
  function readCaptions() {
    const now = Date.now();
    let items = [];
    try { items = P.captions(); } catch (e) { items = []; }
    items.forEach((it) => {
      if (!it.text) return;
      let r = lines.get(it.el);
      if (!r) { r = { text: '', said: '', speaker: it.speaker, changed: now }; lines.set(it.el, r); }
      if (it.text !== r.text) { r.text = it.text; r.speaker = it.speaker || r.speaker; r.changed = now; }
    });
    lines.forEach((r, el) => {
      const gone = !el.isConnected;
      const ended = /[.?!]$/.test(r.text);
      if (gone || now - r.changed > (ended ? 450 : 800)) flush(r);
      if (gone) lines.delete(el);
    });
  }
  function flush(r) {
    if (r.text.length <= r.said.length && r.text.startsWith(r.said)) return;
    // only the words not sent yet (captions grow as people keep talking, and get corrected)
    let fresh = r.text;
    if (r.said && r.text.startsWith(r.said)) fresh = r.text.slice(r.said.length);
    else if (r.said) {
      let k = 0;
      const a = r.said.split(' '), b = r.text.split(' ');
      while (k < a.length && k < b.length && a[k] === b[k]) k++;
      fresh = b.slice(Math.max(k, a.length)).join(' ');
    }
    r.said = r.text;
    fresh = U.norm(fresh);
    if (fresh.replace(/[^a-z0-9]/gi, '').length < 2) return;
    const self = /^you$/i.test(r.speaker) || selfNames.indexOf(String(r.speaker).toLowerCase()) >= 0;
    send({ type: 'caption', speaker: r.speaker || 'Someone', text: fresh, self });
  }

  // ---- chat
  async function chat(text) {
    let input = P.chat.input();
    if (!input) {
      U.click(U.find(P.chat.open));
      for (let i = 0; i < 10 && !input; i++) { await wait(300); input = P.chat.input(); }
    }
    if (!input) { send({ type: 'log', text: 'chat box not found' }); return false; }
    U.typeInto(input, text);
    await wait(150);
    const btn = U.find(P.chat.send);
    if (btn) U.click(btn); else U.pressEnter(input);
    return true;
  }

  // ---- leaving
  let leaving = false;
  async function leave() {
    leaving = true;
    const btn = (P.id === 'teams' && U.first('#hangup-button, [data-tid="hangup-main-btn"], [data-tid="call-hangup"]')) || U.find(P.leave);
    U.click(btn);
    await wait(700);
    const confirm = U.find(P.leaveConfirm);
    if (confirm) U.click(confirm);
    await wait(800);
    setState('left', 'zoope left the meeting.');
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- the join flow
  let joinedAt = 0, captionTimer = null;
  let state = 'opening', named = new WeakSet(), lastJoin = 0, captionTries = 0, captionsState = null, tick = null;
  function setState(s, detail) {
    if (state === s) return;
    state = s;
    send({ type: 'status', state: s, detail: detail || '', platform: P.id, url: location.href });
    if (s === 'left' || s === 'error') { clearInterval(tick); clearInterval(captionTimer); }
  }

  function step(session) {
    if (state === 'left') return;
    const text = U.bodyText();
    if (P.ended.test(text) && state !== 'opening') { setState('left', 'The meeting ended or zoope was removed.'); return; }

    if (P.inCall()) {
      if (state !== 'joined') { setState('joined'); joinedAt = Date.now(); }
      // some apps (Zoom) only offer audio and video after joining: turn them on in the first half minute
      if (Date.now() - joinedAt < 30000) { const on = U.find(P.turnOn); if (on) U.click(on); }
      if (captionsState !== 'on' && captionTries < 12) {
        captionTries++;
        captionsState = P.captionsOn();
        if (captionTries === 12 && captionsState !== 'on') send({ type: 'log', text: 'captions: could not turn them on; turn on captions in the meeting so zoope can follow it' });
      }
      if (!captionTimer) captionTimer = setInterval(() => { try { readCaptions(); } catch (e) { /* page changing */ } }, 150);
      return;
    }
    if (P.lobby.test(text)) { setState('lobby', 'Waiting to be let in.'); return; }

    // pre-join
    if (P.launcher) U.click(U.find(P.launcher));
    U.click(U.find(P.dismiss));
    const input = P.nameInput();
    if (input && !named.has(input) && !input.value) { U.setValue(input, session.name); named.add(input); }
    if (P.switches) P.switches().forEach((sw) => U.click(sw));
    const on = U.find(P.turnOn);
    if (on) U.click(on);
    const join = U.find(P.join);
    if (join && Date.now() - lastJoin > 2500) {
      lastJoin = Date.now();
      U.click(join);
      setState('joining');
    } else if (state === 'opening') setState('prejoin');
  }

  hello.then((session) => {
    if (!session) return;
    selfNames = [String(session.name || '').toLowerCase()];
    // every frame serves camera requests; the join flow runs in the top page
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'signal') toPage('signal', msg.data);
      else if (msg.type === 'mouth') envelopes.push(msg.env);
      else if (msg.type === 'chat' && top) chat(msg.text).then((ok) => send({ type: 'chatSent', ok, text: msg.text }));
      else if (msg.type === 'leave' && top) leave();
    });
    if (!top) return;
    if (P.route) {
      const to = P.route(location);
      if (to && to !== location.href) { location.replace(to); return; }
    }
    const start = () => { tick = setInterval(() => { try { step(session); } catch (e) { send({ type: 'log', text: 'step: ' + e.message }); } }, 700); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  });
})();
