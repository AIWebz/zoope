/*
 * Liveness: is this a real person in front of the camera and microphone, not a photo, a replayed video
 * or an AI-generated voice? Used when making the avatar and the voice, so nobody can clone someone
 * else from their pictures or recordings.
 *
 * These are on-device checks, not guarantees:
 * - face: the person must blink (a printed or on-screen photo can't), the head must show the small,
 *   natural motion of a living person, and the camera must not be a known virtual camera (OBS,
 *   ManyCam, …) that could feed in a picture or video;
 * - voice: while the passage is read, the lips (seen by the camera) must move with the sound, so a
 *   voice played from a speaker or a file doesn't pass; the microphone must not be a virtual audio
 *   device (VB-Cable, BlackHole, Voicemod, …) and the recording must have a real room's background
 *   noise, not the digital silence of injected audio.
 */
(function (global) {
  'use strict';
  var VIRTUAL_CAM = /obs|virtual|manycam|snap camera|xsplit|camtwist|droidcam|epoccam|mmhmm|e2esoft|splitcam|youcam/i;
  var VIRTUAL_MIC = /virtual|vb-audio|cable (input|output)|blackhole|soundflower|loopback|voicemod|voice ?changer|krisp|elevenlabs|resemble|rvc|stereo mix|what u hear/i;

  function trackLabel(stream, kind) {
    var t = stream && stream.getTracks().filter(function (x) { return x.kind === kind; })[0];
    return t ? String(t.label || '') : '';
  }
  /* Known virtual devices: a reason string, or ''. */
  function deviceCheck(stream) {
    var cam = trackLabel(stream, 'video'), mic = trackLabel(stream, 'audio');
    if (VIRTUAL_CAM.test(cam)) return 'The camera "' + cam + '" is a virtual camera, which can show a photo or video. Use your real webcam.';
    if (VIRTUAL_MIC.test(mic)) return 'The microphone "' + mic + '" is a virtual audio device, which can play in a recording or an AI voice. Use your real microphone.';
    return '';
  }

  var D = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); };
  // eye openness (both eyes), relative to eye width
  function eyeOpen(lm) { return (D(lm[159], lm[145]) + D(lm[386], lm[374])) / (D(lm[33], lm[133]) + D(lm[362], lm[263])); }
  function mouthOpen(lm) { return D(lm[13], lm[14]) / D(lm[10], lm[152]); }

  // a small mirrored frame, enough for landmarks
  function frameOf(video) {
    var w = 320, h = Math.round(320 * (video.videoHeight || 240) / (video.videoWidth || 320));
    var c = frameOf.c || (frameOf.c = document.createElement('canvas'));
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(video, 0, 0, w, h);
    return c;
  }

  /*
   * Watches the face for `ms` (the user is asked to blink). Resolves to { ok, reason, blinks, motion }.
   */
  function watchFace(video, ms) {
    var FM = global.ZoopeFaceMesh, samples = [], end = Date.now() + ms;
    return FM.load().then(function () {
      return new Promise(function (resolve) {
        (function step() {
          FM.detect(frameOf(video)).then(function (lm) {
            if (lm) samples.push({ eye: eyeOpen(lm), x: lm[1].x, y: lm[1].y, size: D(lm[10], lm[152]) });
          }).catch(function () {}).then(function () {
            if (Date.now() < end) setTimeout(step, 40); else resolve(judge());
          });
        })();
      });
    });
    function judge() {
      if (samples.length < 8) return { ok: false, reason: 'I couldn\'t see your face clearly. Face the camera in good light.' };
      var eyes = samples.map(function (s) { return s.eye; }).sort(function (a, b) { return a - b; });
      var open = eyes[Math.floor(eyes.length * 0.75)], blinks = 0, shut = false;
      samples.forEach(function (s) {
        if (!shut && s.eye < open * 0.62) { shut = true; blinks++; } else if (shut && s.eye > open * 0.85) shut = false;
      });
      // natural micro-motion of a living head (a photo held still is near zero; normalised by face size)
      var size = samples.reduce(function (a, s) { return a + s.size; }, 0) / samples.length;
      var mx = samples.reduce(function (a, s) { return a + s.x; }, 0) / samples.length, my = samples.reduce(function (a, s) { return a + s.y; }, 0) / samples.length;
      var motion = Math.sqrt(samples.reduce(function (a, s) { return a + (s.x - mx) * (s.x - mx) + (s.y - my) * (s.y - my); }, 0) / samples.length) / size;
      if (!blinks) return { ok: false, blinks: 0, motion: motion, reason: 'I didn\'t see you blink. A photo can\'t be used: look at the camera, blink a couple of times and try again.' };
      if (motion < 0.0008) return { ok: false, blinks: blinks, motion: motion, reason: 'Your face didn\'t move at all, like a photo or a paused video. Use your live face and try again.' };
      return { ok: true, blinks: blinks, motion: motion };
    }
  }

  /*
   * While the voice is recorded: samples the lips from the camera with the sound level.
   * start(video) → { level(v), stop() → { ok, reason, corr, faceShare } }
   */
  function watchTalking(video) {
    var FM = global.ZoopeFaceMesh, pairs = [], level = 0, frames = 0, seen = 0, running = true;
    FM.load().then(function () {
      (function step() {
        if (!running) return;
        frames++;
        var lv = level;
        FM.detect(frameOf(video)).then(function (lm) {
          if (lm) { seen++; pairs.push([mouthOpen(lm), lv]); }
        }).catch(function () {}).then(function () { if (running) setTimeout(step, 80); });
      })();
    }).catch(function () { running = false; });
    return {
      level: function (v) { level = v; },
      stop: function () {
        running = false;
        var faceShare = frames ? seen / frames : 0;
        if (pairs.length < 20 || faceShare < 0.6) return { ok: false, faceShare: faceShare, reason: 'Keep your face in view of the camera while you read, so zoope can see it\'s really you speaking.' };
        var n = pairs.length, ma = 0, mb = 0;
        pairs.forEach(function (p) { ma += p[0]; mb += p[1]; }); ma /= n; mb /= n;
        var sab = 0, saa = 0, sbb = 0;
        pairs.forEach(function (p) { sab += (p[0] - ma) * (p[1] - mb); saa += (p[0] - ma) * (p[0] - ma); sbb += (p[1] - mb) * (p[1] - mb); });
        var corr = saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
        if (corr < 0.2) return { ok: false, corr: corr, faceShare: faceShare, reason: 'Your lips didn\'t move with the voice that was recorded, as happens with a recording or an AI voice played to the microphone. Read the passage aloud yourself.' };
        return { ok: true, corr: corr, faceShare: faceShare };
      }
    };
  }

  /* The recording itself: a real room has background noise between words; injected audio is digitally silent. */
  function audioCheck(samples, rate) {
    var n = Math.round(rate * 0.05), frames = [];
    for (var i = 0; i + n <= samples.length; i += n) {
      var e = 0;
      for (var j = i; j < i + n; j++) e += samples[j] * samples[j];
      frames.push(Math.sqrt(e / n));
    }
    frames.sort(function (a, b) { return a - b; });
    var floor = frames[Math.floor(frames.length * 0.05)] || 0;
    if (floor < 1e-5) return { ok: false, floor: floor, reason: 'The recording has perfectly silent gaps, which a real microphone in a room never has. This happens when audio is played in digitally (for example an AI voice). Record with your real microphone.' };
    return { ok: true, floor: floor };
  }

  global.ZoopeLiveness = { deviceCheck: deviceCheck, watchFace: watchFace, watchTalking: watchTalking, audioCheck: audioCheck };
})(window);
