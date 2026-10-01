/*
 * zoope's AI engine: a language model running in this browser (see brainworker.js).
 *
 * The rule engine (engine.js) still decides *when* to speak. When it decides to
 * answer a question or reply to a statement, the model writes the reply in the
 * user's voice from their notes and the conversation so far. Guard rails:
 * - it may only state facts from the notes; when they don't cover it, it says UNKNOWN;
 * - every number and name in a reply must appear in the notes or the conversation,
 *   otherwise the reply is thrown away;
 * - if the model is slow (in a live call, a reply that lags is worse than a simple
 *   one), the rule engine's reply is used instead.
 */
(function (global) {
  'use strict';
  var worker = null, seq = 0, pending = {}, state = 'off', device = '', progress = 0, listeners = [];

  function emit() { listeners.forEach(function (fn) { fn({ state: state, device: device, progress: progress }); }); }
  function call(msg, timeout) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      worker.postMessage(Object.assign({ id: id }, msg));
      if (timeout) setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error('timeout')); } }, timeout);
    });
  }
  var retries = 0;
  function retryLater() {
    if (retries >= 5) return;
    retries++;
    var again = function () { window.removeEventListener('online', again); clearTimeout(t); if (state === 'error') { try { worker.terminate(); } catch (e) { /* gone */ } worker = null; load(); } };
    var t = setTimeout(again, 60000 * retries);
    window.addEventListener('online', again);
  }
  function load() {
    if (worker) return;
    try { worker = new Worker(new URL('js/brainworker.js', document.baseURI), { type: 'module' }); } catch (e) { state = 'error'; emit(); return; }
    worker.onmessage = function (e) {
      var m = e.data;
      if (m.kind === 'progress') { progress = m.total ? m.loaded / m.total : 0; emit(); return; }
      var p = pending[m.id];
      if (m.kind === 'ready') { state = 'ready'; device = m.device; emit(); }
      if (m.kind === 'error' && m.id === 0) { state = 'error'; emit(); retryLater(); }
      if (!p) return;
      delete pending[m.id];
      if (m.kind === 'error') p.reject(new Error(m.message)); else p.resolve(m);
    };
    state = 'loading'; emit();
    worker.postMessage({ id: 0, kind: 'load' });
  }

  function words(s) { return String(s).match(/[A-Za-z0-9][\w'%.-]*/g) || []; }
  // numbers and proper names the reply uses must come from what zoope was given
  function grounded(reply, sources) {
    var known = ' ' + sources.join(' ').toLowerCase() + ' ';
    return words(reply).every(function (w, i, all) {
      var isNum = /\d/.test(w);
      var prev = i > 0 ? all[i - 1] : '';
      var isName = /^[A-Z][a-z]/.test(w) && i > 0 && !/[.!?]$/.test(prev) && w !== 'I' && !/^I'/.test(w);
      if (!isNum && !isName) return true;
      return known.indexOf(w.toLowerCase().replace(/[.,]+$/, '')) >= 0;
    });
  }

  /*
   * opts: { name, speaker, text, notes: [string], history: [{speaker, text, ai}], timeout }
   * Resolves to { text } with a grounded reply, { unknown: true } when the notes don't
   * cover it, or null when the model isn't ready or too slow.
   */
  function reply(opts) {
    if (state !== 'ready') return Promise.resolve(null);
    var name = opts.name, notes = opts.notes || [];
    var sys = 'You are ' + name + ' in a video meeting. Speak as ' + name + ' in the first person: natural, warm and brief ' +
      '(one or two short sentences, under 35 words), like a real colleague talking.\n' +
      'What you know (your notes):\n' + (notes.length ? notes.map(function (n) { return '- ' + n; }).join('\n') : '- (nothing)') + '\n' +
      'Rules: only state facts that are in your notes. If the notes do not answer what was asked, reply with exactly UNKNOWN. ' +
      'Never invent numbers, dates, names, decisions or promises. If the line needs no facts (small talk, an update someone gave), respond naturally without adding facts. ' +
      'If someone sincerely asks whether you are an AI or a bot, say you are ' + name + '\'s AI avatar speaking from their notes.';
    var convo = (opts.history || []).slice(-8).map(function (h) { return (h.ai ? 'You' : h.speaker) + ': ' + h.text; }).join('\n');
    var user = (convo ? 'Conversation so far:\n' + convo + '\n\n' : '') + opts.speaker + ' just said: "' + opts.text + '"\nReply as ' + name + '.';
    return call({ kind: 'ask', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens: 56 }, opts.timeout || 3000)
      .then(function (m) {
        var t = String(m.text || '').replace(/^["“]|["”]$/g, '').replace(/^(You|Me|\w+):\s*/, '').trim();
        if (!t || /\bUNKNOWN\b/.test(t)) return { unknown: true };
        if (words(t).length > 60) return null;
        var sources = notes.concat((opts.history || []).map(function (h) { return h.speaker + ' ' + h.text; }), [name, opts.speaker, opts.text]);
        return grounded(t, sources) ? { text: t } : null;
      }).catch(function () { return null; });
  }

  global.ZoopeBrain = {
    load: load, reply: reply,
    ready: function () { return state === 'ready'; },
    status: function () { return { state: state, device: device, progress: progress }; },
    onStatus: function (fn) { listeners.push(fn); fn({ state: state, device: device, progress: progress }); }
  };
})(window);
