/*
 * Real meetings, through the zoope browser extension.
 *
 * zoope has no access to Zoom, Google Meet or Teams APIs. Instead, the zoope
 * extension opens the meeting in the platform's own web app, joins it with the
 * user's name, and gives the app zoope's avatar as its camera and zoope's voice
 * as its microphone. The meeting's live captions come back here, so the
 * on-device engine can follow the conversation and decide when to answer.
 *
 * This tab stays the brain: it decides what to say, makes the voice, and
 * streams it to the meeting tab over a local WebRTC link (no server involved).
 */
(function (global) {
  'use strict';

  var version = null, seq = 0, pending = {}, sessions = {}, onAvailable = [], aiListeners = [];

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || !e.data.zoopeExt) return;
    var m = e.data.zoopeExt;
    if (m.hello) {
      var first = !version;
      version = m.hello;
      if (first) onAvailable.forEach(function (fn) { fn(version); });
      return;
    }
    if (m.id && pending[m.id]) { pending[m.id](m.reply || {}); delete pending[m.id]; return; }
    if (m.event && /^ai/.test(m.event.type || '')) { aiListeners.forEach(function (fn) { fn(m.event); }); return; }
    if (m.event && m.event.sessionId && sessions[m.event.sessionId]) sessions[m.event.sessionId]._event(m.event);
  });
  window.postMessage({ zoopeApp: { type: 'hello' } }, location.origin);

  function call(msg, timeout) {
    return new Promise(function (resolve) {
      var id = ++seq;
      pending[id] = resolve;
      window.postMessage({ zoopeApp: { id: id, msg: msg } }, location.origin);
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; resolve({ ok: false, error: 'The zoope extension did not answer.' }); }
      }, timeout || 8000);
    });
  }

  /* Which platform a meeting link belongs to, or null. */
  function platformOf(url) {
    var host;
    try { host = new URL(url).hostname; } catch (e) { return null; }
    if (host === 'meet.google.com') return 'meet';
    if (/(^|\.)zoom\.us$/.test(host)) return 'zoom';
    if (host === 'teams.microsoft.com' || host === 'teams.live.com') return 'teams';
    return null;
  }

  function Session(id, audio) {
    this.id = id;
    this.audio = audio;
    this.handlers = {};
    this.pc = null;
  }
  Session.prototype.on = function (type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); return this; };
  Session.prototype._emit = function (type, data) { (this.handlers[type] || []).forEach(function (fn) { fn(data); }); };
  Session.prototype._send = function (msg) { return call({ type: 'toMeeting', sessionId: this.id, msg: msg }); };
  Session.prototype._event = function (ev) {
    if (ev.type === 'signal') { this._signal(ev.data); return; }
    this._emit(ev.type, ev);
  };

  // the meeting tab offers a receive-only audio link; answer it with zoope's voice
  Session.prototype._signal = function (data) {
    var self = this;
    if (data.sdp && data.sdp.type === 'offer') {
      if (this.pc) this.pc.close();
      var pc = this.pc = new RTCPeerConnection({ iceServers: [] });
      var track = this.audio.destination.stream.getAudioTracks()[0];
      pc.addTrack(track, this.audio.destination.stream);
      pc.onicecandidate = function (e) { if (e.candidate) self._send({ type: 'signal', data: { candidate: e.candidate.toJSON() } }); };
      pc.onconnectionstatechange = function () { self._emit('voiceLink', { state: pc.connectionState }); };
      pc.setRemoteDescription(data.sdp).then(function () { return pc.createAnswer(); }).then(function (answer) {
        return pc.setLocalDescription(answer).then(function () {
          self._send({ type: 'signal', data: { sdp: { type: answer.type, sdp: answer.sdp } } });
        });
      }).catch(function (err) { self._emit('log', { text: 'voice link: ' + err.message }); });
    } else if (data.candidate && this.pc) {
      this.pc.addIceCandidate(data.candidate).catch(function () {});
    }
  };

  /* Where the voice goes: pass to neuralvoice.speak(text, onLevel, out). */
  Session.prototype.voiceOut = function () {
    var self = this;
    return {
      context: this.audio.context,
      destination: this.audio.destination,
      onEnvelope: function (env) { self._send({ type: 'mouth', env: env }); }
    };
  };

  /* Plays raw samples into the meeting (with the matching mouth movement). */
  Session.prototype.playSamples = function (samples, rate) {
    var ac = this.audio.context, self = this;
    return ac.resume().then(function () {
      var buf = ac.createBuffer(1, samples.length, rate);
      buf.getChannelData(0).set(samples);
      var src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(self.audio.destination);
      var at = ac.currentTime + 0.05;
      src.start(at);
      self._send({ type: 'mouth', env: { at: Date.now() + 50, step: 20, shapes: ZoopeVoice.shapeTrack(samples, rate, 20) } });
      return new Promise(function (resolve) { src.onended = resolve; });
    });
  };

  // the avatar's face in the meeting: { think } while the AI writes a reply
  Session.prototype.face = function (f) { return this._send({ type: 'face', face: f }); };
  // zoope was talked over: the mouth stops with the voice
  Session.prototype.cutVoice = function () { return this._send({ type: 'mouthCut' }); };
  Session.prototype.chat = function (text) { return this._send({ type: 'chat', text: text }); };
  Session.prototype.focus = function () { return call({ type: 'focusMeeting', sessionId: this.id }); };
  Session.prototype.leave = function () { return this._send({ type: 'leave' }); };
  Session.prototype.end = function () {
    if (this.pc) this.pc.close();
    delete sessions[this.id];
    return call({ type: 'end', sessionId: this.id });
  };

  /*
   * Opens and joins a meeting. Call from a click, so the voice's audio can start.
   * opts: { url, name, title, portrait }. Resolves to a Session.
   */
  function join(opts) {
    var platform = platformOf(opts.url);
    if (!platform) return Promise.reject(new Error('That link isn\'t a Zoom, Google Meet or Teams meeting link.'));
    if (!version) return Promise.reject(new Error('The zoope extension isn\'t installed in this browser.'));
    var AC = window.AudioContext || window.webkitAudioContext;
    var context = new AC();
    context.resume();
    var audio = { context: context, destination: context.createMediaStreamDestination() };
    return call({ type: 'join', url: opts.url, platform: platform, name: opts.name, title: opts.title, portrait: opts.portrait || null }, 15000)
      .then(function (r) {
        if (!r.ok) throw new Error(r.error || 'The extension could not open the meeting.');
        var s = new Session(r.sessionId, audio);
        s.platform = platform;
        sessions[r.sessionId] = s;
        return s;
      });
  }

  global.ZoopeBridge = {
    available: function () { return !!version; },
    version: function () { return version; },
    onAvailable: function (fn) { if (version) fn(version); else onAvailable.push(fn); },
    platformOf: platformOf,
    join: join,
    // the AI engine installed in the extension (its popup's Connect button)
    ai: {
      status: function () { return call({ type: 'aiStatus' }, 8000); },
      connect: function () { return call({ type: 'aiConnect' }, 15000); },
      ask: function (id, messages, maxTokens) { return call({ type: 'aiAsk', id: id, messages: messages, maxTokens: maxTokens }, 15000); },
      stop: function (id) { return call({ type: 'aiStop', id: id }); },
      warm: function (system, lines) { return call({ type: 'aiWarm', system: system, lines: lines || null }); },
      garbled: function () { return call({ type: 'aiGarbled' }); },
      on: function (fn) { aiListeners.push(fn); }
    }
  };
})(window);
