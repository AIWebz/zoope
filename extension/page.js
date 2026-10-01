/*
 * zoope extension: runs in the meeting app's own page (main world).
 *
 * When this tab was opened by zoope, the meeting app's camera and microphone
 * are zoope's: getUserMedia returns the live avatar (a canvas rendered by the
 * extension) and zoope's voice (a WebRTC audio track from the zoope tab).
 * In any other tab, everything is passed through untouched.
 */
(() => {
  const md = navigator.mediaDevices;
  if (!md || window.__zoopePage) return;
  window.__zoopePage = true;

  const origGUM = md.getUserMedia.bind(md);
  const origEnum = md.enumerateDevices.bind(md);
  const RTC = window.RTCPeerConnection;
  const origQuery = navigator.permissions && navigator.permissions.query.bind(navigator.permissions);

  // ---- messages with the extension's script in this frame
  let seq = 0;
  const pending = new Map();
  const handlers = {};
  function ask(type, data) {
    return new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      window.postMessage({ __zoope: 'to-ext', id, type, data }, '*');
    });
  }
  function tell(type, data) { window.postMessage({ __zoope: 'to-ext', type, data }, '*'); }
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__zoope !== 'to-page') return;
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.data); pending.delete(d.id); return; }
    if (handlers[d.type]) handlers[d.type](d.data);
  });

  let activeP = null;
  function active() {
    if (!activeP) activeP = Promise.race([ask('active'), new Promise((r) => setTimeout(() => r(null), 4000))]).then((r) => !!(r && r.active));
    return activeP;
  }

  // ---- zoope's media
  let media = null;
  function setup() {
    if (media) return media;
    media = (async () => {
      // voice: receive-only WebRTC audio from the zoope tab. The receiver track exists
      // immediately and carries sound once connected.
      const pc = new RTC({ iceServers: [] });
      const tr = pc.addTransceiver('audio', { direction: 'recvonly' });
      const audio = tr.receiver.track;
      // remote audio only flows once something consumes it
      const sink = new Audio();
      sink.muted = true;
      sink.srcObject = new MediaStream([audio]);
      sink.play().catch(() => {});
      pc.onicecandidate = (e) => { if (e.candidate) tell('signal', { candidate: e.candidate.toJSON() }); };
      handlers.signal = async (m) => {
        try {
          if (m.sdp) await pc.setRemoteDescription(m.sdp);
          else if (m.candidate) await pc.addIceCandidate(m.candidate);
        } catch (err) { tell('log', 'signal: ' + err.message); }
      };
      pc.onconnectionstatechange = () => tell('log', 'voice link ' + pc.connectionState);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      tell('signal', { sdp: { type: offer.type, sdp: offer.sdp } });

      // face: the avatar canvas, drawn by the extension in this frame
      const r = await ask('canvas');
      const canvas = r && document.getElementById(r.id);
      const video = canvas ? canvas.captureStream(30).getVideoTracks()[0] : null;
      if (video) try { video.contentHint = 'motion'; } catch (e) { /* optional */ }
      return { pc, audio, video, label: (r && r.label) || 'zoope' };
    })();
    return media;
  }

  function wants(c) { return !!c && c !== false; }

  md.getUserMedia = async function (constraints) {
    if (!(await active())) return origGUM(constraints);
    const m = await setup();
    const tracks = [];
    if (wants(constraints && constraints.audio)) tracks.push(m.audio.clone());
    if (wants(constraints && constraints.video) && m.video) tracks.push(m.video.clone());
    if (!tracks.length) throw new DOMException('Requested device not found', 'NotFoundError');
    tell('log', 'gave the meeting ' + tracks.map((t) => t.kind).join(' + '));
    return new MediaStream(tracks);
  };

  md.enumerateDevices = async function () {
    if (!(await active())) return origEnum();
    const real = await origEnum().catch(() => []);
    const dev = (kind, deviceId, label) => ({ kind, deviceId, label, groupId: 'zoope', toJSON() { return { kind, deviceId, label, groupId: 'zoope' }; } });
    return [
      dev('audioinput', 'zoope-voice', 'zoope voice'),
      dev('videoinput', 'zoope-avatar', 'zoope avatar')
    ].concat(real.filter((d) => d.kind === 'audiooutput'));
  };

  // the browser never prompts for zoope's camera and microphone
  if (origQuery) {
    navigator.permissions.query = async function (desc) {
      if (desc && (desc.name === 'camera' || desc.name === 'microphone') && (await active())) {
        return { name: desc.name, state: 'granted', status: 'granted', onchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
      }
      return origQuery(desc);
    };
  }

  // legacy API used by some web clients
  if (navigator.getUserMedia || navigator.webkitGetUserMedia) {
    const legacy = function (c, ok, fail) { md.getUserMedia(c).then(ok, fail); };
    navigator.getUserMedia = legacy;
    navigator.webkitGetUserMedia = legacy;
  }
})();
