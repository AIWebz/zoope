/*
 * Voice cloning from the alphabet, all on-device.
 *
 * The user says A to Z one letter at a time. Each letter name contains
 * English speech sounds ("B" = b + ee, "F" = eh + f, ...), so zoope cuts
 * the recordings into sound units in the user's own voice. To speak, it
 * turns text into sounds with pronunciation rules, then stitches the
 * matching units together with pitch smoothing and crossfades.
 */
(function (global) {
  'use strict';

  var RATE = 16000;
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  /* ---------------------------- recording ---------------------------- */

  // Records one letter: waits for speech, stops after a short silence.
  function recordLetter(stream, onLevel) {
    return new Promise(function (resolve, reject) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return reject(new Error('Web Audio is not supported in this browser.'));
      var ac = new AC();
      var src = ac.createMediaStreamSource(stream);
      var proc = ac.createScriptProcessor(1024, 1, 1);
      var mute = ac.createGain();
      mute.gain.value = 0;
      src.connect(proc); proc.connect(mute); mute.connect(ac.destination);

      var pre = [], chunks = [], started = false, speechMs = 0, silenceMs = 0, waitedMs = 0;
      var noise = 0.004, chunkMs = 1024 / ac.sampleRate * 1000, done = false;

      proc.onaudioprocess = function (e) {
        if (done) return;
        var buf = new Float32Array(e.inputBuffer.getChannelData(0));
        var rms = 0;
        for (var i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
        rms = Math.sqrt(rms / buf.length);
        if (onLevel) onLevel(Math.min(1, rms * 8));
        var thr = Math.max(0.012, noise * 3.5);

        if (!started) {
          waitedMs += chunkMs;
          noise = noise * 0.9 + rms * 0.1;
          pre.push(buf); if (pre.length > 4) pre.shift(); // keep ~90ms before speech starts
          if (rms > thr && waitedMs > 150) { started = true; chunks = pre.slice(); }
          if (waitedMs > 6000) finish(null);
          return;
        }
        chunks.push(buf);
        if (rms > thr * 0.6) { speechMs += chunkMs; silenceMs = 0; } else { silenceMs += chunkMs; }
        if ((silenceMs > 320 && speechMs > 120) || speechMs + silenceMs > 2500) finish(chunks);
      };

      function finish(result) {
        done = true;
        src.disconnect(); proc.disconnect();
        var sr = ac.sampleRate;
        ac.close();
        if (onLevel) onLevel(0);
        if (!result) return resolve(null);
        var total = result.reduce(function (s, c) { return s + c.length; }, 0);
        var all = new Float32Array(total), off = 0;
        result.forEach(function (c) { all.set(c, off); off += c.length; });
        resolve(trim(normalise(resample(all, sr, RATE))));
      }
    });
  }

  function resample(data, from, to) {
    if (from === to) return data;
    var ratio = from / to, n = Math.floor(data.length / ratio), out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = i * ratio, i0 = Math.floor(x), f = x - i0;
      out[i] = data[i0] * (1 - f) + (data[i0 + 1] || 0) * f;
    }
    return out;
  }

  function normalise(d) {
    var peak = 0;
    for (var i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak < 1e-4) return d;
    var k = 0.9 / peak, out = new Float32Array(d.length);
    for (i = 0; i < d.length; i++) out[i] = d[i] * k;
    return out;
  }

  // Trim leading/trailing quiet parts (10ms frames).
  function trim(d) {
    var f = frames(d), thr = 0.012, a = 0, b = f.length - 1; // low enough to keep quiet 's'/'f' hiss
    while (a < f.length && f[a].rms < thr) a++;
    while (b > a && f[b].rms < thr) b--;
    return d.slice(Math.max(0, (a - 2) * 160), Math.min(d.length, (b + 3) * 160));
  }

  function frames(d) {
    var out = [];
    for (var i = 0; i + 160 <= d.length; i += 160) {
      var rms = 0, zc = 0;
      for (var j = i; j < i + 160; j++) {
        rms += d[j] * d[j];
        if (j > i && (d[j] >= 0) !== (d[j - 1] >= 0)) zc++;
      }
      out.push({ rms: Math.sqrt(rms / 160), zcr: zc / 160 });
    }
    return out;
  }

  /* ------------------------- cutting into sounds ------------------------- */

  // Which sounds each letter name contains. `on`: consonant at the start,
  // `off`: consonant at the end. Numbers are fallback split points (fraction).
  var LETTER_SOUNDS = {
    A: { v: 'ei' }, E: { v: 'ii' }, I: { v: 'ai' }, O: { v: 'ou' },
    B: { on: 'b', v: 'ii', at: 0.16 }, D: { on: 'd', v: 'ii', at: 0.16 }, P: { on: 'p', v: 'ii', at: 0.16, unvoiced: true },
    T: { on: 't', v: 'ii', at: 0.16, unvoiced: true }, C: { on: 's', v: 'ii', at: 0.38, unvoiced: true },
    G: { on: 'jh', v: 'ii', at: 0.28 }, V: { on: 'v', v: 'ii', at: 0.24 }, Z: { on: 'z', v: 'ii', at: 0.3 },
    J: { on: 'jh', v: 'ei', at: 0.26 }, K: { on: 'k', v: 'ei', at: 0.2, unvoiced: true },
    Q: { on: 'k', v: 'uu', at: 0.3, unvoiced: true }, U: { on: 'y', v: 'uu', at: 0.25 }, Y: { on: 'w', v: 'ai', at: 0.24 },
    F: { v: 'eh', off: 'f', at: 0.5, unvoiced: true }, S: { v: 'eh', off: 's', at: 0.5, unvoiced: true },
    X: { v: 'eh', off: 'ks', at: 0.4, unvoiced: true }, H: { v: 'ei', off: 'ch', at: 0.6, unvoiced: true },
    L: { v: 'eh', off: 'l', at: 0.55 }, M: { v: 'eh', off: 'm', at: 0.55 }, N: { v: 'eh', off: 'n', at: 0.55 },
    R: { v: 'aa', off: 'r', at: 0.55 }, W: { v: 'uh', at: 0 }
  };

  function voicedRange(d) {
    var f = frames(d), peak = 0;
    f.forEach(function (x) { peak = Math.max(peak, x.rms); });
    var isV = f.map(function (x) { return x.rms > peak * 0.18 && x.zcr < 0.22; });
    var a = isV.indexOf(true), b = isV.lastIndexOf(true);
    return { a: a < 0 ? 0 : a * 160, b: b < 0 ? d.length : (b + 1) * 160 };
  }

  function buildUnits(clips) {
    var u = {};
    function put(name, data, from, to) {
      from = Math.max(0, Math.floor(from)); to = Math.min(data.length, Math.floor(to));
      if (to - from > 320 && !u[name]) u[name] = data.slice(from, to);
    }
    LETTERS.forEach(function (L) {
      var d = clips[L], s = LETTER_SOUNDS[L];
      if (!d || d.length < 800) return;
      var n = d.length, vr = voicedRange(d), cut;
      if (L === 'W') { // "double-u": take the final "yoo" as a spare "uu"
        put('uu', d, n * 0.7, n);
        put('uh', d, n * 0.12, n * 0.3);
        return;
      }
      if (s.on) {
        cut = s.unvoiced && vr.a > 400 ? vr.a : n * s.at;
        put(s.on, d, 0, cut);
        put(s.v, d, cut, n);
      } else if (s.off) {
        cut = s.unvoiced && vr.b < n - 400 ? vr.b : n * s.at;
        put(s.v, d, 0, cut);
        if (s.off === 'ks') { put('k', d, cut, cut + (n - cut) * 0.35); put('s', d, cut + (n - cut) * 0.35, n); }
        else put(s.off, d, cut, n);
        if (s.off === 'ch') put('sh', d, cut + (n - cut) * 0.3, n);
      } else {
        put(s.v, d, 0, n);
      }
    });
    // fill gaps with the closest sounds we have
    var near = { sh: 's', uh: 'aa', aa: 'eh', eh: 'ei', ch: 'sh', jh: 'd', z: 's', v: 'f', w: 'uu', y: 'ii', r: 'aa', ks: 'k' };
    for (var k in near) if (!u[k] && u[near[k]]) u[k] = u[near[k]];
    return u;
  }

  /* ------------------------ text to speech sounds ------------------------ */

  var WORDS = {
    the: 'd uh', a: 'uh', an: 'eh n', to: 't uu', you: 'y uu', your: 'y ou r', i: 'ai', is: 'ih z', of: 'uh v',
    are: 'aa r', was: 'w uh z', one: 'w uh n', do: 'd uu', does: 'd uh z', have: 'h ae v', said: 's eh d',
    what: 'w uh t', who: 'h uu', hi: 'h ai', hello: 'h eh l ou', everyone: 'eh v r ii w uh n', thanks: 't ae n k s',
    thank: 't ae n k', there: 'd eh r', their: 'd eh r', they: 'd ei', be: 'b ii', me: 'm ii', we: 'w ii', he: 'h ii',
    she: 'sh ii', no: 'n ou', so: 's ou', go: 'g ou', ok: 'ou k ei', okay: 'ou k ei', my: 'm ai', by: 'b ai',
    here: 'h ii r', "i'm": 'ai m', "i'll": 'ai l', "it's": 'ih t s', "don't": 'd ou n t', "can't": 'k ae n t',
    will: 'w ih l', for: 'f ou r', from: 'f r uh m', with: 'w ih d', update: 'uh p d ei t', meeting: 'm ii t ih n',
    sure: 'sh ou r', yes: 'y eh s', can: 'k ae n', just: 'jh uh s t', know: 'n ou', new: 'n uu', great: 'g r ei t',
    good: 'g oo d', quick: 'k w ih k', any: 'eh n ii', many: 'm eh n ii', some: 's uh m', come: 'k uh m',
    done: 'd uh n', people: 'p ii p uh l', talk: 't aa k', soon: 's uu n', bye: 'b ai', questions: 'k w eh s ch uh n z',
    question: 'k w eh s ch uh n', happy: 'h ae p ii', share: 'sh eh r', week: 'w ii k', friday: 'f r ai d ei',
    monday: 'm uh n d ei',
    two: 't uu', three: 't r ii', four: 'f ou r', five: 'f ai v', six: 's ih k s', seven: 's eh v eh n', eight: 'ei t',
    nine: 'n ai n', ten: 't eh n', eleven: 'ih l eh v eh n', twelve: 't w eh l v', thirteen: 't r t ii n',
    fourteen: 'f ou r t ii n', fifteen: 'f ih f t ii n', sixteen: 's ih k s t ii n', seventeen: 's eh v eh n t ii n',
    eighteen: 'ei t ii n', nineteen: 'n ai n t ii n', twenty: 't w eh n t ii', thirty: 't r t ii', forty: 'f ou r t ii',
    fifty: 'f ih f t ii', hundred: 'h uh n d r eh d', zero: 'z ii r ou', tuesday: 't uu z d ei', thursday: 't r z d ei', wednesday: 'w eh n z d ei', been: 'b ih n'
  };
  var VOICED_TH = /^(the|this|that|these|those|they|them|then|there|their|than|though|with|other|mother|father|brother|either|rather|together|whether)$/;
  var NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  var TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

  function numberWords(n) {
    n = parseInt(n, 10);
    if (n < 20) return NUM[n];
    if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + NUM[n % 10] : '');
    if (n < 1000) return NUM[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numberWords(n % 100) : '');
    return String(n).split('').map(function (c) { return NUM[+c]; }).join(' ');
  }

  var VOW = /[aeiou]/;
  var LONG = { a: 'ei', e: 'ii', i: 'ai', o: 'ou', u: 'uu' };
  var SHORT = { a: 'ae', e: 'eh', i: 'ih', o: 'aa', u: 'uh' };

  function wordToSounds(w) {
    if (WORDS[w]) return WORDS[w].split(' ');
    if (/^\d+$/.test(w)) return [].concat.apply([], numberWords(w).split(' ').map(wordToSounds));
    w = w.replace(/'s$/, 's').replace(/'/g, '');
    var out = [], i = 0, n = w.length;
    var magicE = /[aeiou][^aeiouwy]e$/.test(w) && n > 3;
    function at(s) { return w.substr(i, s.length) === s; }
    while (i < n) {
      var c = w[i], next = w[i + 1] || '';
      if (at('tch')) { out.push('ch'); i += 3; continue; }
      if (at('igh')) { out.push('ai'); i += 3; continue; }
      if (at('tion')) { out.push('sh', 'uh', 'n'); i += 4; continue; }
      if (at('ch')) { out.push('ch'); i += 2; continue; }
      if (at('sh')) { out.push('sh'); i += 2; continue; }
      if (at('th')) { out.push(VOICED_TH.test(w) ? 'd' : 't'); i += 2; continue; }
      if (at('ph')) { out.push('f'); i += 2; continue; }
      if (at('ck')) { out.push('k'); i += 2; continue; }
      if (at('ng')) { out.push('n'); i += 2; continue; }
      if (at('qu')) { out.push('k', 'w'); i += 2; continue; }
      if (at('wh')) { out.push('w'); i += 2; continue; }
      if (at('gh')) { i += 2; continue; }
      if (i === 0 && at('kn')) { out.push('n'); i += 2; continue; }
      if (i === 0 && at('wr')) { out.push('r'); i += 2; continue; }
      if (at('ee') || at('ea') || at('ie')) { out.push('ii'); i += 2; continue; }
      if (at('oo')) { out.push('uu'); i += 2; continue; }
      if (at('ou') || at('ow')) { out.push('aa', 'uu'); i += 2; continue; }
      if (at('oa') || at('oe')) { out.push('ou'); i += 2; continue; }
      if (at('ai') || at('ay') || at('ey')) { out.push(i + 2 === n && at('ey') ? 'ii' : 'ei'); i += 2; continue; }
      if (at('oi') || at('oy')) { out.push('aa', 'ii'); i += 2; continue; }
      if (at('au') || at('aw')) { out.push('aa'); i += 2; continue; }
      if (at('ew') || at('ue')) { out.push('uu'); i += 2; continue; }
      if (at('ar')) { out.push('aa', 'r'); i += 2; continue; }
      if (at('or')) { out.push('ou', 'r'); i += 2; continue; }
      if (at('er') || at('ir') || at('ur')) { out.push('r'); i += 2; continue; }
      if (VOW.test(c)) {
        if (c === 'e' && i === n - 1 && n > 2) { i++; continue; } // silent final e
        var isMagic = magicE && i === n - 3;
        var open = i === n - 1 && n <= 3; // "go", "me"
        out.push(isMagic || open ? LONG[c] : SHORT[c]);
        i++; continue;
      }
      if (c === 'y') { out.push(i === 0 ? 'y' : (i === n - 1 ? (n <= 3 ? 'ai' : 'ii') : 'ih')); i++; continue; }
      if (c === next && c !== 'e') { i++; continue; } // double consonants
      if (c === 'c') { out.push(/[eiy]/.test(next) ? 's' : 'k'); i++; continue; }
      if (c === 'g') { out.push(/[eiy]/.test(next) && !/^(get|give|girl|gift)/.test(w) ? 'jh' : 'g'); i++; continue; }
      if (c === 'x') { out.push('k', 's'); i++; continue; }
      if (c === 'j') { out.push('jh'); i++; continue; }
      if (c === 's' && VOW.test(w[i - 1] || '') && VOW.test(next) && i > 0) { out.push('z'); i++; continue; }
      if ('bdfhklmnprstvwz'.indexOf(c) >= 0) { out.push(c); i++; continue; }
      i++;
    }
    return out;
  }

  function textToSounds(text) {
    var seq = [];
    String(text).toLowerCase().replace(/[—–-]/g, ' , ').split(/(\s+|[,.!?;:])/).forEach(function (tok) {
      if (!tok || /^\s+$/.test(tok)) { if (seq.length) seq.push('_'); return; }
      if (/^[,;:]$/.test(tok)) { seq.push(','); return; }
      if (/^[.!?]$/.test(tok)) { seq.push(tok === '?' ? '?' : '.'); return; }
      var clean = tok.replace(/[^a-z0-9']/g, '');
      if (clean) seq = seq.concat(wordToSounds(clean));
    });
    return seq;
  }

  /* ------------------------------ synthesis ------------------------------ */

  var LONG_V = { ei: 1, ii: 1, ai: 1, ou: 1, uu: 1 };
  var SHORT_V = { eh: 'eh', ae: 'eh', ih: 'ii', aa: 'aa', uh: 'uh', oo: 'uu' };
  var STOPS = { p: 1, t: 1, k: 1, b: 1, d: 1, g: 1 };
  var FRIC = { s: 1, f: 1, sh: 1, ch: 1, z: 1, v: 1, h: 1 };

  function pitchOf(d) {
    var n = Math.min(d.length, 1024), best = 0, bestLag = 0;
    var off = Math.max(0, Math.floor(d.length / 2 - n / 2));
    for (var lag = 40; lag < 230; lag++) { // 70–400 Hz at 16 kHz
      var c = 0;
      for (var i = off; i < off + n - lag; i++) c += d[i] * d[i + lag];
      if (c > best) { best = c; bestLag = lag; }
    }
    return bestLag ? RATE / bestLag : 0;
  }

  function stretchTo(d, ratio) { // resample: ratio > 1 raises pitch, shortens
    var n = Math.floor(d.length / ratio), out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = i * ratio, i0 = Math.floor(x), f = x - i0;
      out[i] = d[i0] * (1 - f) + (d[i0 + 1] || 0) * f;
    }
    return out;
  }

  function Voice(clips) {
    this.clips = clips;
    this.units = buildUnits(clips);
    var ps = [];
    for (var k in this.units) if (LONG_V[k] || k === 'eh' || k === 'aa') { var p = pitchOf(this.units[k]); if (p) ps.push(p); }
    ps.sort(function (a, b) { return a - b; });
    this.basePitch = ps.length ? ps[Math.floor(ps.length / 2)] : 0;
    this.pitchCache = {};
  }

  Voice.prototype.piece = function (name, targetPitch) {
    var u, dur, gain = 1;
    var base = SHORT_V[name] || name;
    if (name === 'h') { u = this.units.sh || this.units.f; gain = 0.25; dur = 0.05; }
    else if (name === 'g') { u = this.units.k; gain = 0.8; dur = 0.05; }
    else u = this.units[base];
    if (!u) return null;
    var isV = LONG_V[base] || SHORT_V[name] || base === 'eh' || base === 'aa' || base === 'uh';
    if (!dur) dur = LONG_V[name] ? 0.17 : isV ? 0.09 : STOPS[name] ? 0.06 : FRIC[name] ? 0.09 : 0.07;
    var len = Math.floor(dur * RATE);

    if (isV) {
      // smooth out pitch differences between letters
      if (this.basePitch && targetPitch) {
        var key = base;
        if (!(key in this.pitchCache)) this.pitchCache[key] = pitchOf(u);
        var p = this.pitchCache[key];
        if (p) u = stretchTo(u, Math.max(0.85, Math.min(1.18, targetPitch / p)));
      }
      var mid = Math.floor(u.length / 2);
      var from = Math.max(0, mid - Math.floor(len / 2));
      u = u.slice(from, Math.min(u.length, from + len));
    } else if (STOPS[name] || name === 'g') {
      u = u.slice(0, Math.min(u.length, len));
    } else {
      var m2 = Math.floor(u.length / 2), f2 = Math.max(0, m2 - Math.floor(len / 2));
      u = u.slice(f2, Math.min(u.length, f2 + len));
    }
    if (gain !== 1) { var g = new Float32Array(u.length); for (var i = 0; i < u.length; i++) g[i] = u[i] * gain; u = g; }
    return u;
  };

  Voice.prototype.render = function (text) {
    var seq = textToSounds(text), pieces = [], self = this;
    // intonation: gentle fall across each sentence, rise at the end of questions
    var sentenceStarts = [0];
    seq.forEach(function (s, i) { if (s === '.' || s === '?') sentenceStarts.push(i + 1); });
    var fade = Math.floor(0.012 * RATE);
    seq.forEach(function (s, i) {
      if (s === '_') { pieces.push(new Float32Array(Math.floor(0.03 * RATE))); return; }
      if (s === ',') { pieces.push(new Float32Array(Math.floor(0.18 * RATE))); return; }
      if (s === '.' || s === '?') { pieces.push(new Float32Array(Math.floor(0.32 * RATE))); return; }
      var st = 0; sentenceStarts.forEach(function (x) { if (x <= i) st = x; });
      var endIdx = seq.length; for (var j = i; j < seq.length; j++) if (seq[j] === '.' || seq[j] === '?') { endIdx = j; break; }
      var pos = (i - st) / Math.max(1, endIdx - st);
      var contour = seq[endIdx] === '?' ? (pos > 0.75 ? 1 + (pos - 0.75) * 0.6 : 1) : 1.06 - pos * 0.12;
      var piece = self.piece(s, self.basePitch * contour);
      if (piece) pieces.push(piece);
    });
    var total = pieces.reduce(function (sum, p) { return sum + p.length; }, 0);
    var out = new Float32Array(total + RATE * 0.1), off = 0;
    pieces.forEach(function (p) {
      var start = Math.max(0, off - fade);
      for (var i = 0; i < p.length; i++) {
        var w = 1;
        if (i < fade) w = i / fade;
        else if (i > p.length - fade) w = (p.length - i) / fade;
        out[start + i] += p[i] * w;
      }
      off = start + p.length;
    });
    return out.slice(0, off + fade);
  };

  Voice.prototype.speak = function (text, onLevel) {
    var data = this.render(text);
    return new Promise(function (resolve) {
      var AC = global.AudioContext || global.webkitAudioContext;
      var ac = new AC();
      var buf = ac.createBuffer(1, data.length, RATE);
      buf.getChannelData(0).set(data);
      var src = ac.createBufferSource();
      src.buffer = buf;
      var an = ac.createAnalyser();
      an.fftSize = 512;
      src.connect(an); an.connect(ac.destination);
      var td = new Float32Array(an.fftSize), playing = true;
      (function loop() {
        if (!playing) return;
        an.getFloatTimeDomainData(td);
        var rms = 0;
        for (var i = 0; i < td.length; i++) rms += td[i] * td[i];
        if (onLevel) onLevel(Math.min(1, Math.sqrt(rms / td.length) * 5));
        requestAnimationFrame(loop);
      })();
      src.onended = function () { playing = false; if (onLevel) onLevel(0); ac.close(); resolve(); };
      src.start();
    });
  };

  Voice.prototype.missing = function () {
    var self = this;
    return LETTERS.filter(function (L) { return !self.clips[L]; });
  };

  /* ------------------------------ storage ------------------------------ */

  function encode(clip) { // Float32 -> Int16 -> base64
    var i16 = new Int16Array(clip.length);
    for (var i = 0; i < clip.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(clip[i] * 32767)));
    var bytes = new Uint8Array(i16.buffer), s = '';
    for (i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function decode(b64) {
    var s = atob(b64), bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    var i16 = new Int16Array(bytes.buffer), out = new Float32Array(i16.length);
    for (i = 0; i < i16.length; i++) out[i] = i16[i] / 32767;
    return out;
  }

  function playClip(clip) {
    var AC = global.AudioContext || global.webkitAudioContext, ac = new AC();
    var buf = ac.createBuffer(1, clip.length, RATE);
    buf.getChannelData(0).set(clip);
    var src = ac.createBufferSource();
    src.buffer = buf; src.connect(ac.destination);
    src.onended = function () { ac.close(); };
    src.start();
  }

  global.ZoopeVoiceClone = {
    LETTERS: LETTERS,
    RATE: RATE,
    recordLetter: recordLetter,
    Voice: Voice,
    textToSounds: textToSounds,
    encode: encode,
    decode: decode,
    playClip: playClip
  };
})(window);
