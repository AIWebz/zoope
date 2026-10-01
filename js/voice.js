/*
 * Voice scan + voice output, all on-device.
 * Measures the user's pitch (autocorrelation), loudness and speaking pace,
 * then tunes the browser's built-in speech synthesiser to match.
 */
(function (global) {
  'use strict';

  function autoCorrelate(buf, sampleRate) {
    var n = buf.length, rms = 0, i;
    for (i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    if (rms < 0.01) return -1;
    var minLag = Math.floor(sampleRate / 400), maxLag = Math.floor(sampleRate / 70);
    var corr = new Float64Array(maxLag + 2), bestCorr = 0;
    for (var lag = minLag; lag <= maxLag + 1; lag++) {
      var c = 0;
      for (i = 0; i < n - lag; i++) c += buf[i] * buf[i + lag];
      corr[lag] = c / (n - lag);
      if (lag <= maxLag && corr[lag] > bestCorr) bestCorr = corr[lag];
    }
    if (bestCorr < rms * rms * 0.3) return -1;
    // the first strong peak is the period; later peaks at 2x, 3x the period cause octave errors
    for (lag = minLag + 1; lag <= maxLag; lag++) {
      if (corr[lag] >= bestCorr * 0.88 && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
        // refine between samples with a parabola
        var a = corr[lag - 1], b = corr[lag], c2 = corr[lag + 1], d = a - 2 * b + c2;
        var shift = d ? 0.5 * (a - c2) / d : 0;
        return sampleRate / (lag + shift);
      }
    }
    return -1;
  }

  /* ------------------------- voice scan (analysis) ------------------------- */

  // radix-2 FFT magnitude spectrum of a frame (length must be a power of two)
  function spectrum(frame) {
    var n = frame.length, re = new Float64Array(n), im = new Float64Array(n), i, j, k;
    for (i = 0; i < n; i++) re[i] = frame[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))); // Hann
    for (i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { var t = re[i]; re[i] = re[j]; re[j] = t; }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        var cr = 1, ci = 0;
        for (k = 0; k < len / 2; k++) {
          var ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          var ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai;
          re[i + k] += ar; im[i + k] += ai;
          var ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    var mag = new Float64Array(n / 2);
    for (i = 0; i < n / 2; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    return mag;
  }

  /*
   * Scans a recording of the user's voice and measures it: typical pitch,
   * pitch range, speaking pace, brightness (timbre) and loudness, plus a pitch
   * contour for display. Everything here is measured, nothing is assumed.
   */
  function analyzeSamples(samples, rate) {
    var hop = Math.round(rate * 0.02), win = 1024, frames = [], i;
    for (var start = 0; start + win <= samples.length; start += hop) {
      var f = samples.subarray(start, start + win), rms = 0;
      for (i = 0; i < win; i++) rms += f[i] * f[i];
      frames.push({ start: start, rms: Math.sqrt(rms / win) });
    }
    if (!frames.length) return { ok: false, reason: 'The recording is too short.' };
    var sorted = frames.map(function (x) { return x.rms; }).sort(function (a, b) { return a - b; });
    var noise = sorted[Math.floor(sorted.length * 0.1)], peak = sorted[Math.floor(sorted.length * 0.98)];
    var gate = Math.max(noise * 3, peak * 0.12, 0.004);

    var pitches = [], contour = [], centroids = [], loud = [];
    frames.forEach(function (fr) {
      var f = samples.subarray(fr.start, fr.start + win);
      if (fr.rms < gate) { contour.push(null); return; }
      loud.push(fr.rms);
      var p = autoCorrelate(f, rate);
      contour.push(p > 0 ? p : null);
      if (p > 0) pitches.push(p);
      var mag = spectrum(f), num = 0, den = 0;
      for (var b = 2; b < mag.length; b++) { var hz = b * rate / win; if (hz > 6000) break; num += hz * mag[b]; den += mag[b]; }
      if (den > 0) centroids.push(num / den);
    });
    var voicedSeconds = loud.length * hop / rate;
    if (pitches.length < 25 || voicedSeconds < 3) {
      return { ok: false, reason: 'Not enough clear speech was detected. Read the passage aloud in a quiet room, a little closer to the mic.' };
    }
    var q = function (arr, k) { var a = arr.slice().sort(function (x, y) { return x - y; }); return a[Math.min(a.length - 1, Math.floor(a.length * k))]; };
    var median = q(pitches, 0.5), lo = q(pitches, 0.1), hi = q(pitches, 0.9);

    // syllable-like energy peaks per voiced second = speaking pace
    var env = frames.map(function (x) { return x.rms; }), peaks = 0, armed = true;
    for (i = 2; i < env.length - 2; i++) {
      if (armed && env[i] > gate * 1.6 && env[i] >= env[i - 1] && env[i] >= env[i + 1] && env[i] >= env[i - 2] && env[i] >= env[i + 2]) { peaks++; armed = false; }
      else if (env[i] < gate * 1.1) armed = true;
    }
    var meanLoud = loud.reduce(function (a, b) { return a + b; }, 0) / loud.length;
    return {
      ok: true,
      pitchHz: Math.round(median),
      lowHz: Math.round(lo),
      highHz: Math.round(hi),
      rangeSemitones: +(12 * Math.log2(hi / lo)).toFixed(1),
      pace: +(peaks / voicedSeconds).toFixed(1),
      brightnessHz: Math.round(q(centroids, 0.5) || 0),
      loudnessDb: Math.round(20 * Math.log10(meanLoud)),
      voicedSeconds: +voicedSeconds.toFixed(1),
      register: median < 165 ? 'low' : 'high',
      contour: contour.filter(function (_, k) { return k % 2 === 0; })
    };
  }

  /* 16-bit PCM <-> base64, for keeping recordings in local storage */
  function encodePCM(clip) {
    var i16 = new Int16Array(clip.length);
    for (var i = 0; i < clip.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(clip[i] * 32767)));
    var bytes = new Uint8Array(i16.buffer), s = '';
    for (i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function decodePCM(b64) {
    var s = atob(b64), bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    var i16 = new Int16Array(bytes.buffer), out = new Float32Array(i16.length);
    for (i = 0; i < i16.length; i++) out[i] = i16[i] / 32767;
    return out;
  }

  function pickVoice(profile) {
    var voices = (global.speechSynthesis && speechSynthesis.getVoices()) || [];
    var en = voices.filter(function (v) { return /^en/i.test(v.lang); });
    if (!en.length) en = voices;
    var lowHints = /(male|david|daniel|alex|fred|george|guy|james|mark|tom|rishi|aaron|arthur)/i;
    var highHints = /(female|samantha|victoria|karen|zira|susan|moira|tessa|fiona|serena|aria|jenny|libby|sonia)/i;
    var want = profile && profile.register === 'low' ? lowHints : highHints;
    var matches = en.filter(function (v) {
      return want.test(v.name) && !(want === lowHints && /female/i.test(v.name));
    });
    return matches[0] || en[0] || null;
  }

  function synthParams(profile) {
    if (!profile || !profile.ok) return { pitch: 1, rate: 1 };
    // typical synth voices sit around 120Hz (low) / 210Hz (high)
    var base = profile.register === 'low' ? 120 : 210;
    var pitch = Math.max(0.5, Math.min(1.6, profile.pitchHz / base));
    var rate = Math.max(0.8, Math.min(1.3, 0.75 + profile.pace * 0.1));
    return { pitch: +pitch.toFixed(2), rate: +rate.toFixed(2) };
  }

  /* ------------------------------ visemes ------------------------------ */
  // Mouth shapes: open (jaw), wide (lips spread, as in "ee"), round (lips rounded, as in "oo"),
  // teeth (lower lip to the teeth or teeth together, as in "f", "s").
  var SHAPES = {
    a: { open: 0.85, wide: 0.25 }, e: { open: 0.45, wide: 0.8 }, i: { open: 0.3, wide: 1 },
    o: { open: 0.6, round: 0.85 }, u: { open: 0.25, round: 1 }, w: { open: 0.15, round: 1 },
    m: { open: 0 }, f: { open: 0.08, teeth: 1 }, s: { open: 0.15, wide: 0.4, teeth: 0.8 },
    sh: { open: 0.2, round: 0.6, teeth: 0.7 }, th: { open: 0.22, teeth: 0.6 }, l: { open: 0.35, wide: 0.2 },
    r: { open: 0.3, round: 0.4 }, k: { open: 0.4 }, rest: { open: 0 }
  };
  var LETTER = { a: 'a', e: 'e', i: 'i', y: 'i', o: 'o', u: 'u', w: 'w', m: 'm', b: 'm', p: 'm', f: 'f', v: 'f',
    s: 's', z: 's', c: 's', x: 's', t: 's', d: 's', n: 's', j: 'sh', l: 'l', r: 'r', k: 'k', g: 'k', q: 'w', h: 'k' };
  var DIGRAPH = { oo: 'u', ee: 'i', ea: 'i', th: 'th', sh: 'sh', ch: 'sh', ph: 'f', wh: 'w', ou: 'o', ow: 'o', ai: 'e', ay: 'e', ng: 'k', ck: 'k', qu: 'w' };
  var VOWEL = { a: 1, e: 1, i: 1, o: 1, u: 1, w: 0 };

  /* The mouth shapes a word is sounded out with, each with a relative duration. */
  function wordVisemes(word) {
    var w = String(word).toLowerCase().replace(/[^a-z]/g, ''), out = [];
    if (w.length > 3 && /[^aeiou]e$/.test(w)) w = w.slice(0, -1); // silent final e
    for (var i = 0; i < w.length; i++) {
      var two = w.substr(i, 2), key = DIGRAPH[two];
      if (key) i++; else key = LETTER[w[i]];
      if (!key) continue;
      if (out.length && out[out.length - 1].key === key) { out[out.length - 1].dur += 0.5; continue; }
      out.push({ key: key, dur: VOWEL[key] ? 1.6 : key === 'm' || key === 'f' ? 1.1 : 0.8 });
    }
    return out;
  }
  function shape(key, k) {
    var s = SHAPES[key] || SHAPES.rest;
    k = k == null ? 1 : k;
    return { open: (s.open || 0) * k, wide: s.wide || 0, round: s.round || 0, teeth: s.teeth || 0 };
  }

  /*
   * Mouth shape from a stretch of audio: loudness opens the jaw, hiss (many zero
   * crossings) shows the teeth, and where the energy sits in the spectrum tells
   * rounded vowels (energy low, "oo", "oh") from spread ones (energy high, "ee").
   */
  function shapeOf(x, rate, from, to) {
    from = from || 0; to = to || x.length;
    var n = to - from;
    if (n < 16) return shape('rest');
    var a = Math.exp(-2 * Math.PI * 900 / rate), lp = 0, e = 0, el = 0, zc = 0, prev = x[from];
    for (var i = from; i < to; i++) {
      var v = x[i];
      e += v * v;
      if ((v >= 0) !== (prev >= 0)) zc++;
      prev = v;
      lp = (1 - a) * v + a * lp;
      el += lp * lp;
    }
    var loud = Math.min(1, Math.sqrt(e / n) * 5);
    if (loud < 0.03) return shape('rest');
    var zcrHz = zc / n * rate / 2, low = el / (e || 1);
    var sm = function (a0, a1, v2) { var t = Math.max(0, Math.min(1, (v2 - a0) / (a1 - a0))); return t * t * (3 - 2 * t); };
    var fric = sm(1800, 3800, zcrHz);
    var round = sm(0.8, 0.95, low) * (1 - fric), wide = (1 - sm(0.45, 0.72, low)) * (1 - fric);
    return {
      open: Math.min(1, loud * 1.4) * (1 - 0.75 * fric) * (1 - 0.3 * round),
      wide: wide, round: round, teeth: fric * Math.min(1, loud * 4)
    };
  }
  function r2(v) { return Math.round(v * 100) / 100; }
  /* Shapes every `step` ms of a chunk of samples (for streaming to a remote avatar). */
  function shapeTrack(samples, rate, step) {
    var n = Math.max(1, Math.round(rate * step / 1000)), out = [];
    for (var i = 0; i < samples.length; i += n) {
      var sh = shapeOf(samples, rate, i, Math.min(samples.length, i + n));
      out.push([r2(sh.open), r2(sh.wide), r2(sh.round), r2(sh.teeth)]);
    }
    return out;
  }

  /*
   * Speaks text with the user's tuned voice. onLevel(shape) drives lip sync with
   * the mouth shapes of the words being said: each word boundary from the
   * speech engine starts that word's visemes.
   */
  function speak(text, profile, onLevel) {
    return new Promise(function (resolve) {
      var p = synthParams(profile), msPer = 85 / (p.rate || 1);
      // queue of { shape, until } for the word being spoken
      var queue = [], talking = true;
      function sayWord(word) {
        var vs = wordVisemes(word), total = 0;
        vs.forEach(function (v) { total += v.dur; });
        var t = performance.now(), unit = Math.max(1, word.length) * msPer / (total || 1);
        queue = vs.map(function (v) { t += v.dur * unit; return { s: shape(v.key, 0.85 + Math.random() * 0.25), until: t }; });
        queue.push({ s: shape('rest'), until: t + 60 });
      }
      function loop() {
        if (!talking) { if (onLevel) onLevel(shape('rest')); return; }
        var now = performance.now();
        while (queue.length > 1 && queue[0].until < now) queue.shift();
        if (onLevel) onLevel(queue.length ? queue[0].s : shape('rest'));
        requestAnimationFrame(loop);
      }
      var words = text.match(/\S+/g) || [], wi = 0, sawBoundary = false, fallbackTimer = null;
      // without boundary events, step through the words at the estimated pace
      function walk() {
        if (!talking || sawBoundary || wi >= words.length) return;
        var w = words[wi++];
        sayWord(w);
        fallbackTimer = setTimeout(walk, Math.max(1, w.length) * msPer + 90);
      }
      if (!global.speechSynthesis) {
        walk(); loop();
        setTimeout(function () { talking = false; resolve(); }, words.join(' ').length * msPer + 600);
        return;
      }
      var u = new SpeechSynthesisUtterance(text);
      u.pitch = p.pitch; u.rate = p.rate;
      var v = pickVoice(profile);
      if (v) u.voice = v;
      u.onstart = function () { setTimeout(function () { if (!sawBoundary) walk(); }, 250); };
      u.onboundary = function (e) {
        if (e.name && e.name !== 'word') return;
        sawBoundary = true; clearTimeout(fallbackTimer);
        var rest = text.slice(e.charIndex), m = rest.match(/^\S+/);
        if (m) sayWord(m[0]);
      };
      loop();
      var done = function () { talking = false; clearTimeout(fallbackTimer); resolve(); };
      u.onend = done; u.onerror = done;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });
  }

  /* Live transcription of the room using the browser's speech recognition, if present. */
  function listen(onText, onState) {
    var SR = global.SpeechRecognition || global.webkitSpeechRecognition;
    if (!SR) return null;
    var r = new SR();
    r.continuous = true;
    r.interimResults = false;
    r.lang = 'en-US';
    var active = true;
    r.onresult = function (e) {
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) onText(e.results[i][0].transcript.trim());
      }
    };
    r.onend = function () { if (active) { try { r.start(); } catch (err) { /* already started */ } } else if (onState) onState(false); };
    r.onerror = function (e) { if (e.error === 'not-allowed') { active = false; if (onState) onState(false); } };
    r.start();
    if (onState) onState(true);
    return { stop: function () { active = false; r.stop(); } };
  }

  if (global.speechSynthesis) speechSynthesis.getVoices(); // warm up voice list

  global.ZoopeVoice = { shapeOf: shapeOf, shapeTrack: shapeTrack, wordVisemes: wordVisemes, analyzeSamples: analyzeSamples, encodePCM: encodePCM, decodePCM: decodePCM, speak: speak, listen: listen, synthParams: synthParams };
})(window);
