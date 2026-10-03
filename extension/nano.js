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

  function ask(id, messages, post) {
    var lm = LM();
    if (!lm) { post({ id: id, kind: 'error', message: 'this browser has no built-in AI' }); return Promise.resolve(); }
    var sys = messages.filter(function (m) { return m.role === 'system'; }).map(function (m) { return m.content; }).join('\n');
    var user = messages.filter(function (m) { return m.role !== 'system'; }).map(function (m) { return m.content; }).join('\n');
    var ctl = new AbortController(), session = null;
    running[id] = ctl;
    return lm.create(Object.assign({ initialPrompts: sys ? [{ role: 'system', content: sys }] : [], signal: ctl.signal }, LANG)).then(function (s) {
      session = s;
      var stream = s.promptStreaming(user, { signal: ctl.signal });
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

  g.ZoopeNano = { status: status, download: download, ask: ask, stop: stop };
})(typeof self !== 'undefined' ? self : window);
