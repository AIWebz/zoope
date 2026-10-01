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

  /* Speaks text with the user's tuned voice. onLevel(0..1) drives lip sync. */
  function speak(text, profile, onLevel) {
    return new Promise(function (resolve) {
      if (!global.speechSynthesis) {
        // no TTS: fake a mouth movement for the reading time
        var t0 = performance.now(), dur = Math.max(1200, text.length * 55);
        (function loop() {
          var t = performance.now() - t0;
          if (onLevel) onLevel(t < dur ? 0.3 + 0.5 * Math.abs(Math.sin(t / 90)) : 0);
          if (t < dur) requestAnimationFrame(loop); else resolve();
        })();
        return;
      }
      var u = new SpeechSynthesisUtterance(text);
      var p = synthParams(profile);
      u.pitch = p.pitch; u.rate = p.rate;
      var v = pickVoice(profile);
      if (v) u.voice = v;
      var talking = true, pulse = 0;
      u.onboundary = function () { pulse = 1; };
      (function loop() {
        if (!talking) { if (onLevel) onLevel(0); return; }
        pulse *= 0.85;
        if (onLevel) onLevel(0.25 + 0.55 * Math.max(pulse, Math.abs(Math.sin(performance.now() / 85)) * 0.7));
        requestAnimationFrame(loop);
      })();
      var done = function () { talking = false; resolve(); };
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

  global.ZoopeVoice = { analyzeSamples: analyzeSamples, encodePCM: encodePCM, decodePCM: decodePCM, speak: speak, listen: listen, synthParams: synthParams };
})(window);
