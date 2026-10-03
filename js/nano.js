/*
 * Chrome's built-in AI (Gemini Nano, through the Prompt API), when this browser has it.
 *
 * It runs on this computer inside Chrome: no download through zoope, no server, and far more
 * capable than the small model zoope can load itself. Used by the extension (background and AI
 * page) and by the zoope page; a classic script so service workers can importScripts() it.
 *
 * ZoopeNano.status()                      → 'missing' | 'unavailable' | 'downloadable' | 'downloading' | 'available'
 * ZoopeNano.download(onProgress)          → starts Chrome's download of the model (needs a click)
 * ZoopeNano.ask(id, messages, post)       → streams { id, kind: 'token' | 'done' | 'error' } to post()
 * ZoopeNano.stop(id)
 * ZoopeNano.warm(system, lines)           → gets a session with this system prompt (and conversation) ready ahead of time
 *
 * Speed: making a session reads the system prompt and can load the model, which takes a while.
 * So one session per system prompt is kept warm, and each reply runs in a clone of it (instant).
 * The meeting's conversation is added to a session line by line as it happens (append), so a reply
 * only has to read the new question, not the whole meeting again. A user message may carry
 * { lines: [conversation lines], short: 'the prompt without them' } for this.
 */
(function (g) {
  'use strict';
  var LM = function () { return g.LanguageModel || (g.ai && g.ai.languageModel) || null; };
  var LANG = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
  var running = {};

  function status() {
    var lm = LM();
    if (!lm) return Promise.resolve('missing');
    var fn = lm.availability || lm.capabilities;
    return Promise.resolve(fn.call(lm, LANG)).then(function (a) {
      if (a && typeof a === 'object') a = a.available === 'readily' ? 'available' : a.available === 'after-download' ? 'downloadable' : 'unavailable'; // older API
      return a || 'unavailable';
    }).catch(function () { return 'unavailable'; });
  }

  function download(onProgress) {
    var lm = LM();
    if (!lm) return Promise.reject(new Error('this browser has no built-in AI'));
    return lm.create(Object.assign({
      monitor: function (m) { m.addEventListener('downloadprogress', function (e) { if (onProgress) onProgress(e.total ? e.loaded / e.total : e.loaded); }); }
    }, LANG)).then(function (s) { s.destroy(); return true; });
  }

  // the warm session for the current system prompt
  var base = { key: null, p: null };
  function warm(sys) {
    var lm = LM();
    if (!lm) return Promise.reject(new Error('this browser has no built-in AI'));
    sys = sys || '';
    if (base.key === sys && base.p) return base.p;
    var old = base.p;
    if (old) old.then(function (s) { try { s.destroy(); } catch (e) { /* gone */ } }, function () {});
    base.key = sys;
    base.p = lm.create(Object.assign({ initialPrompts: sys ? [{ role: 'system', content: sys }] : [] }, LANG));
    base.p.catch(function () { if (base.key === sys) { base.key = null; base.p = null; } });
    return base.p;
  }
  // a fresh session for one reply: a clone of the warm one, or a new one if cloning isn't possible
  function sessionFor(sys, signal) {
    var lm = LM();
    var fresh = function () { return lm.create(Object.assign({ initialPrompts: sys ? [{ role: 'system', content: sys }] : [], signal: signal }, LANG)); };
    return warm(sys).then(function (b) {
      if (!b.clone) return fresh();
      return b.clone({ signal: signal }).catch(function () { base.key = null; base.p = null; return fresh(); });
    }, fresh);
  }

  // the meeting so far, already read: a clone of the warm session with each conversation line appended
  var conv = { key: null, lines: [], p: null }, noAppend = false;
  function convFor(sys, lines) {
    if (noAppend) return Promise.reject(new Error('no append'));
    var same = conv.key === sys && conv.p && conv.lines.length <= lines.length &&
      conv.lines.every(function (l, i) { return l === lines[i]; });
    var add;
    if (!same) {
      // the old one is freed a little later, once any copy being made from it is done
      if (conv.p) conv.p.then(function (s) { setTimeout(function () { try { s.destroy(); } catch (e) { /* gone */ } }, 5000); }, function () {});
      conv.key = sys;
      conv.p = warm(sys).then(function (b) { return b.clone(); }).then(function (s) {
        if (typeof s.append !== 'function') { noAppend = true; try { s.destroy(); } catch (e) { /* gone */ } throw new Error('no append'); }
        return s;
      });
      conv.p.catch(function () { if (conv.key === sys) conv.key = null; });
      add = lines.slice(-40); // a long meeting starts over from its recent lines
    } else add = lines.slice(conv.lines.length);
    conv.lines = lines.slice();
    if (add.length) {
      conv.p = conv.p.then(function (s) {
        return s.append(add.map(function (l) { return { role: 'user', content: l }; })).then(function () {
          // nearly full: start over next time
          var used = s.inputUsage != null ? s.inputUsage : s.tokensSoFar, quota = s.inputQuota || s.maxTokens;
          if (quota && used > quota * 0.7) conv.key = null;
          return s;
        });
      });
      conv.p.catch(function () { conv.key = null; });
    }
    return conv.p;
  }

  function ask(id, messages, post) {
    var lm = LM();
    if (!lm) { post({ id: id, kind: 'error', message: 'this browser has no built-in AI' }); return Promise.resolve(); }
    var sys = messages.filter(function (m) { return m.role === 'system'; }).map(function (m) { return m.content; }).join('\n');
    var user = messages.filter(function (m) { return m.role !== 'system'; }).map(function (m) { return m.content; }).join('\n');
    var ctl = new AbortController(), session = null;
    running[id] = ctl;
    var um = messages.filter(function (m) { return m.role === 'user'; })[0] || {};
    var text = user, made;
    if (um.lines && um.short != null) {
      // the conversation is already in the session: only the new part is read now
      made = convFor(sys, um.lines).then(function (c) { return c.clone({ signal: ctl.signal }); })
        .then(function (c) { text = um.short; return c; })
        .catch(function (err) { if (ctl.signal.aborted) throw err; conv.key = null; return sessionFor(sys, ctl.signal); });
    } else made = sessionFor(sys, ctl.signal);
    return made.then(function (s) {
      session = s;
      var stream = s.promptStreaming(text, { signal: ctl.signal });
      var reader = stream.getReader(), sofar = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          var chunk = String(r.value);
          // older Chrome sent the whole text so far in each chunk; newer sends only the new part
          var delta = sofar && chunk.indexOf(sofar) === 0 ? chunk.slice(sofar.length) : chunk;
          sofar = sofar && chunk.indexOf(sofar) === 0 ? chunk : sofar + delta;
          if (delta) post({ id: id, kind: 'token', text: delta });
          return pump();
        });
      }
      return pump();
    }).then(function () {
      post({ id: id, kind: 'done' });
    }).catch(function (err) {
      if (ctl.signal.aborted) post({ id: id, kind: 'done' });
      else post({ id: id, kind: 'error', message: 'Chrome AI: ' + (err && err.message ? err.message : String(err)) });
    }).then(function () {
      delete running[id];
      if (session) { try { session.destroy(); } catch (e) { /* gone */ } }
    });
  }

  function stop(id) { if (running[id]) { try { running[id].abort(); } catch (e) { /* done */ } } }

  g.ZoopeNano = { status: status, download: download, ask: ask, stop: stop, warm: function (sys, lines) { return (lines ? convFor(sys, lines) : warm(sys)).then(function () { return true; }); } };
})(typeof self !== 'undefined' ? self : window);
