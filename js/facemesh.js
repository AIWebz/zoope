/*
 * Photo-realistic avatar, all on-device.
 * Uses the bundled MediaPipe Face Landmarker to find 478 points on the
 * user's face, then animates the real photo by warping a triangle mesh:
 * the jaw drops and lips part when talking, and the eyelids close to blink.
 */
(function (global) {
  'use strict';

  var SIZE = 400; // stored photo is SIZE x SIZE, cropped around the face
  var landmarkerPromise = null;

  // MediaPipe face-mesh landmark indices
  var UPPER_LIP = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
  var LOWER_LIP_INNER = [95, 88, 178, 87, 14, 317, 402, 318, 324];
  var INNER_LIP_LOOP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
  var EYES = [
    { upper: [246, 161, 160, 159, 158, 157, 173], lower: [7, 163, 144, 145, 153, 154, 155] },
    { upper: [466, 388, 387, 386, 385, 384, 398], lower: [249, 390, 373, 374, 380, 381, 382] }
  ];

  function load() {
    if (!landmarkerPromise) {
      var base = new URL('vendor/', document.baseURI).href;
      landmarkerPromise = import(base + 'mediapipe/vision_bundle.mjs').then(function (vision) {
        return vision.FilesetResolver.forVisionTasks(base + 'mediapipe/wasm').then(function (fileset) {
          return vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: base + 'models/face_landmarker.task', delegate: 'CPU' },
            runningMode: 'IMAGE',
            numFaces: 1
          });
        });
      });
      landmarkerPromise.catch(function () { landmarkerPromise = null; });
    }
    return landmarkerPromise;
  }

  // Person-part segmentation: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 other.
  var segmenterPromise = null;
  function loadSegmenter() {
    if (!segmenterPromise) {
      var base = new URL('vendor/', document.baseURI).href;
      segmenterPromise = import(base + 'mediapipe/vision_bundle.mjs').then(function (vision) {
        return vision.FilesetResolver.forVisionTasks(base + 'mediapipe/wasm').then(function (fileset) {
          return vision.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: base + 'models/selfie_multiclass_256x256.tflite', delegate: 'CPU' },
            runningMode: 'IMAGE',
            outputCategoryMask: true,
            outputConfidenceMasks: false
          });
        });
      });
      segmenterPromise.catch(function () { segmenterPromise = null; });
    }
    return segmenterPromise;
  }

  /* Labels every pixel of a canvas. Resolves to { cats: Uint8Array, w, h } at the mask's own size. */
  function segment(canvas) {
    return loadSegmenter().then(function (seg) {
      var res = seg.segment(canvas);
      var mask = res.categoryMask;
      var out = { cats: new Uint8Array(mask.getAsUint8Array()), w: mask.width, h: mask.height };
      if (res.close) res.close();
      return out;
    });
  }

  /* Face landmarks on a canvas, or null. */
  function detect(canvas) {
    return load().then(function (landmarker) {
      var res = landmarker.detect(canvas);
      return res && res.faceLandmarks && res.faceLandmarks[0] || null;
    });
  }

  /* A mirrored frame from the camera (or a copy of a canvas used as the source). */
  function grab(source) {
    var vw = source.videoWidth || source.width, vh = source.videoHeight || source.height;
    var frame = document.createElement('canvas');
    frame.width = vw; frame.height = vh;
    var fctx = frame.getContext('2d');
    if (source.videoWidth) { fctx.translate(vw, 0); fctx.scale(-1, 1); } // match the mirrored preview
    fctx.drawImage(source, 0, 0, vw, vh);
    return frame;
  }

  /* Scans a video frame. Resolves to a face object, or null when no face is found. */
  function scan(video) {
    return load().then(function (landmarker) {
      var frame = grab(video), vw = frame.width, vh = frame.height;

      var res = landmarker.detect(frame);
      var lm = res && res.faceLandmarks && res.faceLandmarks[0];
      if (!lm) return null;

      var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
      lm.forEach(function (p) {
        minX = Math.min(minX, p.x * vw); maxX = Math.max(maxX, p.x * vw);
        minY = Math.min(minY, p.y * vh); maxY = Math.max(maxY, p.y * vh);
      });
      // a generous crop, shifted up, so the whole head of hair is in the photo
      var side = Math.max(maxX - minX, maxY - minY) * 1.95;
      var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2 - (maxY - minY) * 0.06;
      var sx = cx - side / 2, sy = cy - side / 2, k = SIZE / side;

      var crop = document.createElement('canvas');
      crop.width = SIZE; crop.height = SIZE;
      var cctx = crop.getContext('2d');
      cctx.fillStyle = '#dfe8fb';
      cctx.fillRect(0, 0, SIZE, SIZE);
      cctx.drawImage(frame, sx, sy, side, side, 0, 0, SIZE, SIZE);

      var points = lm.map(function (p) {
        return [Math.round((p.x * vw - sx) * k * 10) / 10, Math.round((p.y * vh - sy) * k * 10) / 10];
      });
      // depth per landmark, in the same pixel scale as x and y (negative = toward the camera)
      var depth = lm.map(function (p) { return Math.round(p.z * vw * k * 10) / 10; });
      var faceFrac = ((maxX - minX) * (maxY - minY)) / (vw * vh);
      return {
        kind: 'mesh',
        photo: crop.toDataURL('image/jpeg', 0.9),
        points: points,
        depth: depth,
        _frame: frame,
        _crop: { sx: sx, sy: sy, k: k },
        confidence: Math.min(1, 0.6 + faceFrac * 3)
      };
    });
  }

  /* ---------------------- Delaunay triangulation ---------------------- */
  function delaunay(pts) {
    var n = pts.length, i;
    var big = 1e5;
    var all = pts.concat([[-big, -big], [big, -big], [0, big]]);
    var tris = [circum(n, n + 1, n + 2)];

    function circum(a, b, c) {
      var ax = all[a][0], ay = all[a][1], bx = all[b][0], by = all[b][1], cx = all[c][0], cy = all[c][1];
      var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      var ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
      var uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
      return { a: a, b: b, c: c, x: ux, y: uy, r2: (ax - ux) * (ax - ux) + (ay - uy) * (ay - uy) };
    }

    for (i = 0; i < n; i++) {
      var px = all[i][0], py = all[i][1], edges = [], keep = [];
      for (var t = 0; t < tris.length; t++) {
        var tr = tris[t], dx = px - tr.x, dy = py - tr.y;
        if (dx * dx + dy * dy <= tr.r2) edges.push([tr.a, tr.b], [tr.b, tr.c], [tr.c, tr.a]);
        else keep.push(tr);
      }
      // boundary edges are the ones that appear exactly once
      var count = {};
      edges.forEach(function (e) {
        var key = Math.min(e[0], e[1]) + '_' + Math.max(e[0], e[1]);
        count[key] = (count[key] || 0) + 1;
      });
      edges.forEach(function (e) {
        var key = Math.min(e[0], e[1]) + '_' + Math.max(e[0], e[1]);
        if (count[key] === 1) keep.push(circum(e[0], e[1], i));
      });
      tris = keep;
    }
    return tris.filter(function (t) { return t.a < n && t.b < n && t.c < n; })
      .map(function (t) { return [t.a, t.b, t.c]; });
  }

  /* ------------------------------ render ------------------------------ */
  var cache = {};

  function prepare(face) {
    var key = face.photo.length + ':' + face.photo.slice(-40);
    if (cache[key]) return cache[key];
    var p = face.points;
    var nose = p[1], chin = p[152], top = p[10];
    var faceW = p[454][0] - p[234][0], faceH = chin[1] - top[1];

    // Static anchors around the face keep the warp from touching hair/neck edges.
    var anchors = [], cx = (p[454][0] + p[234][0]) / 2, cy = (top[1] + chin[1]) / 2;
    for (var a = 0; a < 24; a++) {
      var ang = a / 24 * Math.PI * 2;
      anchors.push([cx + Math.cos(ang) * faceW * 0.78, cy + Math.sin(ang) * faceH * 0.72]);
    }
    [[0, 0], [SIZE / 2, 0], [SIZE, 0], [SIZE, SIZE / 2], [SIZE, SIZE], [SIZE / 2, SIZE], [0, SIZE], [0, SIZE / 2]]
      .forEach(function (c) { anchors.push(c); });

    var rest = p.map(function (q) { return [q[0], q[1]]; }).concat(anchors);
    var upper = {}, lowerInner = {};
    UPPER_LIP.forEach(function (i) { upper[i] = true; });
    LOWER_LIP_INNER.forEach(function (i) { lowerInner[i] = true; });

    var mouthY = (p[13][1] + p[14][1]) / 2;
    var jaw = new Float32Array(p.length); // how much each point follows the jaw
    for (var i = 0; i < p.length; i++) {
      if (upper[i]) { jaw[i] = (i === 61 || i === 291 || i === 78 || i === 308) ? 0.35 : -0.08; continue; }
      if (!lowerInner[i] && p[i][1] <= mouthY + 0.5) continue;
      var wx = 1 - Math.pow((p[i][0] - nose[0]) / (faceW * 0.55), 2);
      var t = Math.max(0, Math.min(1, (p[i][1] - mouthY) / (chin[1] - mouthY)));
      jaw[i] = Math.max(0, wx) * (0.7 + 0.3 * t);
    }

    var img = new Image();
    var prepared = {
      img: img,
      ready: false,
      rest: rest,
      tris: delaunay(rest),
      jaw: jaw,
      n: p.length,
      faceH: faceH,
      eyes: EYES.map(function (e) {
        var ly = e.lower.reduce(function (s, i) { return s + p[i][1]; }, 0) / e.lower.length;
        return { upper: e.upper, lowerY: ly };
      })
    };
    img.onload = function () { prepared.ready = true; };
    img.src = face.photo;
    cache[key] = prepared;
    return prepared;
  }

  function loopPath(ctx, pts) {
    ctx.beginPath();
    INNER_LIP_LOOP.forEach(function (idx, j) {
      if (j === 0) ctx.moveTo(pts[idx][0], pts[idx][1]); else ctx.lineTo(pts[idx][0], pts[idx][1]);
    });
    ctx.closePath();
  }

  function drawTriangle(ctx, img, s, d) {
    var u0 = s[0][0], v0 = s[0][1], u1 = s[1][0], v1 = s[1][1], u2 = s[2][0], v2 = s[2][1];
    var den = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
    if (Math.abs(den) < 0.5) return; // degenerate in the source photo (e.g. closed lips)
    var x0 = d[0][0], y0 = d[0][1], x1 = d[1][0], y1 = d[1][1], x2 = d[2][0], y2 = d[2][1];
    var a = (x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1)) / den;
    var b = (y0 * (v1 - v2) + y1 * (v2 - v0) + y2 * (v0 - v1)) / den;
    var c = (x0 * (u2 - u1) + x1 * (u0 - u2) + x2 * (u1 - u0)) / den;
    var dd = (y0 * (u2 - u1) + y1 * (u0 - u2) + y2 * (u1 - u0)) / den;
    var e = (x0 * (u1 * v2 - u2 * v1) + x1 * (u2 * v0 - u0 * v2) + x2 * (u0 * v1 - u1 * v0)) / den;
    var f = (y0 * (u1 * v2 - u2 * v1) + y1 * (u2 * v0 - u0 * v2) + y2 * (u0 * v1 - u1 * v0)) / den;

    // clip to the destination triangle, grown by ~0.7px to hide seams
    var mx = (x0 + x1 + x2) / 3, my = (y0 + y1 + y2) / 3;
    ctx.save();
    ctx.beginPath();
    [[x0, y0], [x1, y1], [x2, y2]].forEach(function (q, i) {
      var dx = q[0] - mx, dy = q[1] - my, len = Math.sqrt(dx * dx + dy * dy) || 1;
      var gx = q[0] + dx / len * 0.7, gy = q[1] + dy / len * 0.7;
      if (i === 0) ctx.moveTo(gx, gy); else ctx.lineTo(gx, gy);
    });
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, dd, e, f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  /* state: {mouth: 0..1, blink: 0..1, tilt: radians} */
  function render(canvas, face, state) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height, k = W / SIZE;
    var P = prepare(face);
    state = state || {};
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#dfe8fb';
    ctx.fillRect(0, 0, W, H);
    if (!P.ready) return;

    // gentle head motion: tilt the whole picture a touch (scaled up so corners stay filled)
    ctx.translate(W / 2, H / 2);
    ctx.rotate(state.tilt || 0);
    ctx.scale(k * 1.04, k * 1.04);
    ctx.translate(-SIZE / 2, -SIZE / 2);
    ctx.drawImage(P.img, 0, 0);

    var mouth = Math.max(0, Math.min(1, state.mouth || 0));
    var blink = Math.max(0, Math.min(1, state.blink || 0));
    if (mouth < 0.02 && blink < 0.02) { ctx.setTransform(1, 0, 0, 1, 0, 0); return; }

    // deform
    var drop = P.faceH * 0.085 * mouth;
    var cur = P.rest.map(function (q) { return [q[0], q[1]]; });
    var moved = new Uint8Array(cur.length);
    for (var i = 0; i < P.n; i++) {
      if (P.jaw[i] !== 0 && drop > 0) { cur[i][1] += drop * P.jaw[i]; moved[i] = 1; }
    }
    if (blink > 0) {
      P.eyes.forEach(function (eye) {
        eye.upper.forEach(function (i) {
          cur[i][1] += (eye.lowerY - P.rest[i][1]) * 0.9 * blink;
          moved[i] = 1;
        });
      });
    }

    // redraw only triangles that touch a moving point; their outer edges are static
    P.tris.forEach(function (t) {
      if (moved[t[0]] || moved[t[1]] || moved[t[2]]) {
        drawTriangle(ctx, P.img, [P.rest[t[0]], P.rest[t[1]], P.rest[t[2]]], [cur[t[0]], cur[t[1]], cur[t[2]]]);
      }
    });

    // inside of the mouth
    if (mouth > 0.04) {
      var R = P.rest;
      ctx.save();
      loopPath(ctx, cur);
      ctx.fillStyle = '#2a0e10';
      ctx.fill();
      ctx.clip();
      var restGap = R[14][1] - R[13][1];
      if (restGap > 3) {
        // mouth was open in the photo: keep the real teeth, upper half stays, lower half drops with the jaw
        var midY = (R[13][1] + R[14][1]) / 2, left = R[78][0] - 5, width = R[308][0] - R[78][0] + 10;
        ctx.save();
        loopPath(ctx, R); ctx.clip();
        ctx.beginPath(); ctx.rect(left, 0, width, midY); ctx.clip();
        ctx.drawImage(P.img, 0, 0);
        ctx.restore();
        ctx.save();
        ctx.translate(0, cur[14][1] - R[14][1]);
        loopPath(ctx, R); ctx.clip();
        ctx.beginPath(); ctx.rect(left, midY, width, SIZE); ctx.clip();
        ctx.drawImage(P.img, 0, 0);
        ctx.restore();
      } else {
        // mouth was closed in the photo: draw teeth and tongue
        var topY = Math.min(cur[13][1], cur[82][1], cur[312][1]);
        var gap = cur[14][1] - cur[13][1];
        ctx.fillStyle = 'rgba(240,236,228,0.92)';
        ctx.fillRect(cur[78][0], topY - 2, cur[308][0] - cur[78][0], Math.max(1.5, gap * 0.28) + 2);
        ctx.fillStyle = 'rgba(160,60,70,0.55)';
        ctx.beginPath();
        ctx.ellipse((cur[78][0] + cur[308][0]) / 2, cur[14][1], (cur[308][0] - cur[78][0]) * 0.3, gap * 0.35, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  global.ZoopeFaceMesh = { load: load, scan: scan, grab: grab, detect: detect, segment: segment, loadSegmenter: loadSegmenter, render: render, delaunay: delaunay, SIZE: SIZE, INNER_LIP_LOOP: INNER_LIP_LOOP, UPPER_LIP: UPPER_LIP, LOWER_LIP_INNER: LOWER_LIP_INNER, EYES: EYES };
})(window);
