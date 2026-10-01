/*
 * Face scan + avatar generation, all on-device.
 * Samples the camera frame inside the oval guide to learn skin tone,
 * hair colour, eye/brow darkness and face shape, then draws a stylised
 * avatar that can blink and move its mouth while talking.
 */
(function (global) {
  'use strict';

  function avg(px) {
    var r = 0, g = 0, b = 0, n = px.length || 1;
    px.forEach(function (p) { r += p[0]; g += p[1]; b += p[2]; });
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  function median(px) {
    if (!px.length) return [200, 160, 130];
    var ch = [0, 1, 2].map(function (i) {
      var v = px.map(function (p) { return p[i]; }).sort(function (a, b) { return a - b; });
      return v[Math.floor(v.length / 2)];
    });
    return ch;
  }

  function lum(c) { return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; }
  function dist(a, b) { return Math.sqrt(Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2) + Math.pow(a[2] - b[2], 2)); }
  function rgb(c, k) {
    k = k || 1;
    return 'rgb(' + c.map(function (v) { return Math.max(0, Math.min(255, Math.round(v * k))); }).join(',') + ')';
  }

  function region(data, W, x0, y0, x1, y1) {
    var out = [];
    for (var y = Math.floor(y0); y < y1; y += 2) {
      for (var x = Math.floor(x0); x < x1; x += 2) {
        var i = (y * W + x) * 4;
        out.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
    return out;
  }

  /* Analyse a video element; returns a face profile. */
  function scanFace(video) {
    var W = 160, H = 120;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    ctx.translate(W, 0); ctx.scale(-1, 1); // match mirrored preview
    ctx.drawImage(video, 0, 0, W, H);
    var d = ctx.getImageData(0, 0, W, H).data;

    // Oval guide covers ~42% width, 72% height, centred.
    var cx = W / 2, cy = H / 2, rx = W * 0.21, ry = H * 0.36;

    var cheeks = region(d, W, cx - rx * 0.6, cy, cx - rx * 0.2, cy + ry * 0.3)
      .concat(region(d, W, cx + rx * 0.2, cy, cx + rx * 0.6, cy + ry * 0.3));
    var skin = median(cheeks);

    var hair = median(region(d, W, cx - rx * 0.5, cy - ry * 1.0, cx + rx * 0.5, cy - ry * 0.75));
    var eyes = avg(region(d, W, cx - rx * 0.55, cy - ry * 0.25, cx + rx * 0.55, cy - ry * 0.05));
    var lips = median(region(d, W, cx - rx * 0.25, cy + ry * 0.45, cx + rx * 0.25, cy + ry * 0.6));
    var bg = median(region(d, W, 2, 2, 20, H - 2).concat(region(d, W, W - 20, 2, W - 2, H - 2)));

    // Face shape: count skin-like pixels per row to estimate width vs height.
    var rows = [], tol = 42;
    for (var y = 0; y < H; y++) {
      var cnt = 0;
      for (var x = Math.floor(cx - rx * 1.4); x < cx + rx * 1.4; x++) {
        var i = (y * W + x) * 4;
        if (dist([d[i], d[i + 1], d[i + 2]], skin) < tol) cnt++;
      }
      rows.push(cnt);
    }
    var faceRows = rows.filter(function (n) { return n > rx * 0.5; });
    var widest = Math.max.apply(null, rows.concat([1]));
    var aspect = faceRows.length ? Math.min(1.5, Math.max(1.05, faceRows.length / widest)) : 1.3;

    var skinPixels = rows.reduce(function (s, n) { return s + n; }, 0);
    var confidence = Math.min(1, skinPixels / (Math.PI * rx * ry * 0.8));
    var hairIsSkin = dist(hair, skin) < 40;
    var hairIsBg = dist(hair, bg) < 30;

    return {
      skin: skin,
      hair: hairIsSkin ? [skin[0] * 0.9, skin[1] * 0.85, skin[2] * 0.85] : hair,
      bald: hairIsSkin,
      shortHair: hairIsBg,
      eyes: lum(eyes) < 90 ? [40, 30, 25] : [70, 55, 40],
      brow: lum(hair) < lum(skin) - 30 ? hair : [skin[0] * 0.55, skin[1] * 0.5, skin[2] * 0.45],
      lips: dist(lips, skin) > 18 ? lips : [skin[0] * 0.85, skin[1] * 0.6, skin[2] * 0.6],
      aspect: aspect,
      confidence: confidence,
      photo: snapshot(video)
    };
  }

  function snapshot(video) {
    var c = document.createElement('canvas');
    c.width = 200; c.height = 200;
    var ctx = c.getContext('2d');
    var vw = video.videoWidth || 640, vh = video.videoHeight || 480;
    var s = Math.min(vw, vh) * 0.8;
    ctx.translate(200, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, 200, 200);
    return c.toDataURL('image/jpeg', 0.7);
  }

  /* Draws the avatar. state: {mouth: 0..1, blink: 0..1, tilt: radians} */
  function drawAvatar(canvas, face, state) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    state = state || {};
    if (face && face.kind === 'mesh' && global.ZoopeFaceMesh) return global.ZoopeFaceMesh.render(canvas, face, state);
    ctx.clearRect(0, 0, W, H);
    if (!face) {
      // no face yet: a neutral silhouette that reads on light and dark tiles
      ctx.fillStyle = 'rgba(161, 161, 170, .55)';
      ctx.beginPath(); ctx.arc(W / 2, H * 0.4, W * 0.15, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(W / 2, H * 0.98, W * 0.3, H * 0.3, 0, Math.PI, 0); ctx.fill();
      return;
    }
    // background (drawn before the head tilt so it stays square)
    var grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#eaf1ff'); grd.addColorStop(1, '#cddcff');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);

    var cx = W / 2, cy = H * 0.54, fw = W * 0.27, fh = fw * face.aspect;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(state.tilt || 0);
    ctx.translate(-cx, -cy);

    // shoulders
    ctx.fillStyle = '#0b5cff';
    ctx.beginPath();
    ctx.ellipse(cx, H * 1.02, W * 0.42, H * 0.2, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = rgb(face.skin, 0.92);
    ctx.fillRect(cx - fw * 0.35, cy + fh * 0.7, fw * 0.7, H * 0.2);

    // hair back
    if (!face.bald) {
      ctx.fillStyle = rgb(face.hair);
      ctx.beginPath();
      ctx.ellipse(cx, cy - fh * 0.15, fw * 1.12, fh * (face.shortHair ? 1.02 : 1.12), 0, Math.PI, 0);
      if (!face.shortHair) ctx.rect(cx - fw * 1.12, cy - fh * 0.15, fw * 2.24, fh * 0.9);
      ctx.fill();
    }

    // ears
    ctx.fillStyle = rgb(face.skin, 0.95);
    ctx.beginPath(); ctx.ellipse(cx - fw, cy, fw * 0.14, fh * 0.18, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + fw, cy, fw * 0.14, fh * 0.18, 0, 0, Math.PI * 2); ctx.fill();

    // face
    ctx.fillStyle = rgb(face.skin);
    ctx.beginPath(); ctx.ellipse(cx, cy, fw, fh, 0, 0, Math.PI * 2); ctx.fill();

    // fringe
    if (!face.bald) {
      ctx.fillStyle = rgb(face.hair);
      ctx.beginPath();
      ctx.ellipse(cx, cy - fh * 0.72, fw * 0.95, fh * 0.36, 0, Math.PI, 0);
      ctx.fill();
    }

    // cheeks
    ctx.fillStyle = 'rgba(255,120,120,0.18)';
    ctx.beginPath(); ctx.ellipse(cx - fw * 0.55, cy + fh * 0.2, fw * 0.18, fh * 0.09, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + fw * 0.55, cy + fh * 0.2, fw * 0.18, fh * 0.09, 0, 0, Math.PI * 2); ctx.fill();

    // brows
    ctx.strokeStyle = rgb(face.brow); ctx.lineWidth = W * 0.014; ctx.lineCap = 'round';
    var browLift = (state.mouth || 0) * fh * 0.04;
    [-1, 1].forEach(function (s) {
      ctx.beginPath();
      ctx.moveTo(cx + s * fw * 0.2, cy - fh * 0.3 - browLift);
      ctx.quadraticCurveTo(cx + s * fw * 0.4, cy - fh * 0.38 - browLift, cx + s * fw * 0.6, cy - fh * 0.3 - browLift);
      ctx.stroke();
    });

    // eyes
    var open = 1 - (state.blink || 0);
    [-1, 1].forEach(function (s) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.ellipse(cx + s * fw * 0.4, cy - fh * 0.12, fw * 0.15, fh * 0.085 * open + 0.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgb(face.eyes);
      ctx.beginPath(); ctx.ellipse(cx + s * fw * 0.4, cy - fh * 0.12, fw * 0.075, fh * 0.07 * open + 0.3, 0, 0, Math.PI * 2); ctx.fill();
      if (open > 0.4) {
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(cx + s * fw * 0.4 + fw * 0.025, cy - fh * 0.14, fw * 0.02, 0, Math.PI * 2); ctx.fill();
      }
    });

    // nose
    ctx.strokeStyle = rgb(face.skin, 0.75); ctx.lineWidth = W * 0.01;
    ctx.beginPath();
    ctx.moveTo(cx, cy - fh * 0.02);
    ctx.quadraticCurveTo(cx + fw * 0.1, cy + fh * 0.18, cx - fw * 0.03, cy + fh * 0.2);
    ctx.stroke();

    // mouth
    var m = Math.max(0, Math.min(1, state.mouth || 0));
    var my = cy + fh * 0.45, mw = fw * 0.34;
    ctx.fillStyle = rgb(face.lips, 0.6);
    ctx.beginPath();
    ctx.moveTo(cx - mw, my);
    ctx.quadraticCurveTo(cx, my + fh * (0.06 + m * 0.28), cx + mw, my);
    ctx.quadraticCurveTo(cx, my + fh * (0.02 + m * 0.02), cx - mw, my);
    ctx.fill();
    ctx.strokeStyle = rgb(face.lips, 0.85); ctx.lineWidth = W * 0.008;
    ctx.stroke();

    ctx.restore();
  }

  /* Keeps an avatar alive: blinks, idles, and lip-syncs from getLevel() (0..1). */
  var avatar3dModule = null;
  function load3D() {
    if (!avatar3dModule) {
      avatar3dModule = import(new URL('js/avatar3d.js', document.baseURI).href);
      avatar3dModule.catch(function () { avatar3dModule = null; });
    }
    return avatar3dModule;
  }

  /*
   * Keeps an avatar alive: blinks, idles, and lip-syncs from getLevel() (0..1).
   * Faces scanned with depth get the real 3D model (WebGL); the 2D renderer
   * draws until it is ready, and is the fallback when WebGL is unavailable.
   * opts: { interactive, frame: 'head' | 'bust', onReady(info), on3DError(err) }
   */
  function animate(canvas, face, getLevel, opts) {
    opts = opts || {};
    var stop = false, blinkAt = performance.now() + 2000, mouth = 0, stop3D = null, use2D = true;
    function frame(now) {
      if (stop || !use2D) return;
      var target = getLevel ? getLevel() : 0;
      mouth += (target - mouth) * 0.45;
      var blink = 0;
      if (now > blinkAt) {
        var p = (now - blinkAt) / 160;
        blink = p < 1 ? Math.sin(p * Math.PI) : 0;
        if (p >= 1) blinkAt = now + 2200 + Math.random() * 3000;
      }
      drawAvatar(canvas, face, { mouth: mouth, blink: blink, tilt: Math.sin(now / 1400) * 0.03 });
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    if (face && face.kind === 'mesh' && face.depth) {
      load3D().then(function (m) {
        if (stop || !m.has3D(face) || !m.supported()) return;
        use2D = false;
        stop3D = m.attach(canvas, face, getLevel, {
          interactive: opts.interactive,
          frame: opts.frame,
          onReady: opts.onReady,
          onError: function (err) {
            // fall back to the 2D renderer
            stop3D = null; use2D = true; requestAnimationFrame(frame);
            if (opts.on3DError) opts.on3DError(err);
          }
        });
      }).catch(function (err) { if (opts.on3DError) opts.on3DError(err); });
    }
    return function () { stop = true; if (stop3D) stop3D(); };
  }

  global.ZoopeAvatar = { scanFace: scanFace, draw: drawAvatar, animate: animate, load3D: load3D };
})(window);
