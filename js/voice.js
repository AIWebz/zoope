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
    var best = -1, bestCorr = 0;
    for (var lag = minLag; lag <= maxLag; lag++) {
      var c = 0;
      for (i = 0; i < n - lag; i++) c += buf[i] * buf[i + lag];
      c /= (n - lag);
      if (c > bestCorr) { bestCorr = c; best = lag; }
    }
    if (best < 0 || bestCorr < rms * rms * 0.3) return -1;
    return sampleRate / best;
  }

  /* Records `seconds` of audio from a MediaStream. onLevel(0..1) for the meter. */
  function scanVoice(stream, seconds, onLevel) {
    return new Promise(function (resolve, reject) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return reject(new Error('Web Audio is not supported in this browser.'));
      var ac = new AC();
      var src = ac.createMediaStreamSource(stream);
      var an = ac.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      var buf = new Float32Array(an.fftSize);
      var pitches = [], energies = [], start = performance.now();

      function tick() {
        an.getFloatTimeDomainData(buf);
        var rms = 0;
        for (var i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
        rms = Math.sqrt(rms / buf.length);
        energies.push(rms);
        if (onLevel) onLevel(Math.min(1, rms * 8));
        var p = autoCorrelate(buf, ac.sampleRate);
        if (p > 0) pitches.push(p);
        if (performance.now() - start < seconds * 1000) {
          setTimeout(tick, 30);
        } else {
          src.disconnect();
          ac.close();
          if (onLevel) onLevel(0);
          resolve(analyse(pitches, energies, seconds));
        }
      }
      tick();
    });
  }

  function analyse(pitches, energies, seconds) {
    if (pitches.length < 10) {
      return { ok: false, reason: 'I could not hear enough speech. Try again a little closer to the mic.' };
    }
    pitches.sort(function (a, b) { return a - b; });
    var median = pitches[Math.floor(pitches.length / 2)];
    var lo = pitches[Math.floor(pitches.length * 0.1)], hi = pitches[Math.floor(pitches.length * 0.9)];

    // syllable-ish peaks per second → speaking pace
    var mean = energies.reduce(function (s, e) { return s + e; }, 0) / energies.length;
    var peaks = 0, above = false;
    energies.forEach(function (e) {
      if (!above && e > mean * 1.25) { peaks++; above = true; } else if (above && e < mean * 0.9) { above = false; }
    });
    var voiced = energies.filter(function (e) { return e > mean * 0.6; }).length * 0.03;
    var pace = peaks / Math.max(1, voiced);

    return {
      ok: true,
      pitchHz: Math.round(median),
      range: Math.round(hi - lo),
      pace: +pace.toFixed(2),
      loudness: +mean.toFixed(3),
      register: median < 165 ? 'low' : 'high'
    };
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

  global.ZoopeVoice = { scanVoice: scanVoice, speak: speak, listen: listen, synthParams: synthParams };
})(window);
