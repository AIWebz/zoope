/*
 * Multi-view head scan, on-device.
 *
 * Four captures build the 3D head: the front (face and hair), the right side,
 * the left side and the back. Each capture is checked before it is accepted:
 * face landmarks and a person-part segmentation (hair, face skin, ...) show
 * which way the head is facing, where its outline is, and what colour the hair
 * is. Side and back photos are cropped around the head and kept with the
 * outline, so the 3D model can be shaped and textured from them.
 */
(function (global) {
  'use strict';

  var SIZE = 400;
  var HAIR = 1, FACE_SKIN = 3;

  function FM() { return global.ZoopeFaceMesh; }

  // Outline, extents and colours of the head (hair + face skin) in frame pixels.
  function headStats(seg, frame) {
    var W = seg.w, H = seg.h, sx = frame.width / W, sy = frame.height / H;
    var rowMin = new Int32Array(H).fill(-1), rowMax = new Int32Array(H).fill(-1), rowCount = new Int32Array(H);
    var xs = [], hair = 0, face = 0, faceX = 0, hairPx = [], headX = 0, n = 0;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var c = seg.cats[y * W + x];
        if (c !== HAIR && c !== FACE_SKIN) continue;
        n++; headX += x; rowCount[y]++;
        if (rowMin[y] < 0) rowMin[y] = x;
        rowMax[y] = x;
        if ((x + y) % 3 === 0) xs.push(x);
        if (c === HAIR) { hair++; if ((x * 7 + y) % 5 === 0) hairPx.push([x, y]); } else { face++; faceX += x; }
      }
    }
    var minRow = Math.max(3, W * 0.01);
    var top = -1, bottom = -1;
    for (y = 0; y < H; y++) if (rowCount[y] >= minRow) { if (top < 0) top = y; bottom = y; }
    if (n < W * H * 0.01 || top < 0) return null;
    xs.sort(function (a, b) { return a - b; });
    var left = xs[Math.floor(xs.length * 0.02)], right = xs[Math.floor(xs.length * 0.98)];

    // median hair colour, read from the photo
    var hairRgb = null;
    if (hairPx.length > 30) {
      var ctx = frame.getContext('2d'), data = ctx.getImageData(0, 0, frame.width, frame.height).data, r = [], g = [], b = [];
      hairPx.forEach(function (p) {
        var i = (Math.floor(p[1] * sy) * frame.width + Math.floor(p[0] * sx)) * 4;
        r.push(data[i]); g.push(data[i + 1]); b.push(data[i + 2]);
      });
      var med = function (a) { a.sort(function (m, k) { return m - k; }); return a[a.length >> 1]; };
      hairRgb = [med(r), med(g), med(b)];
    }
    return {
      // in frame pixels
      top: top * sy, bottom: bottom * sy, left: left * sx, right: right * sx,
      cx: (headX / n) * sx,
      faceCx: face ? (faceX / face) * sx : null,
      faceShare: face / n, hairShare: hair / n,
      hairRgb: hairRgb,
      rowExtent: function (fy) { var yy = Math.round(fy / sy); return rowMin[yy] < 0 ? null : [rowMin[yy] * sx, rowMax[yy] * sx]; }
    };
  }

  function noseRatio(lm, w) {
    var mid = (lm[234].x + lm[454].x) / 2, half = Math.abs(lm[454].x - lm[234].x) / 2 || 1e-6;
    return (lm[1].x - mid) / half; // <0: nose towards image-left
  }

  /* Step 1: front scan of face and hair. Resolves { ok, face } or { ok: false, reason }. */
  function captureFront(video) {
    return FM().scan(video).then(function (face) {
      if (!face) return { ok: false, reason: 'No face found. Look straight at the camera with your whole head in view, in good light.' };
      var p = face.points;
      var mid = (p[234][0] + p[454][0]) / 2, half = (p[454][0] - p[234][0]) / 2;
      if (Math.abs((p[1][0] - mid) / half) > 0.25) return { ok: false, reason: 'Look straight at the camera for the front scan.' };
      var frame = face._frame, crop = face._crop;
      delete face._frame; delete face._crop;
      return FM().segment(frame).then(function (seg) {
        var st = headStats(seg, frame);
        if (st) {
          var toCropX = function (x) { return (x - crop.sx) * crop.k; }, toCropY = function (y) { return (y - crop.sy) * crop.k; };
          // head width at the temples, between the top of the hair and the eyebrows
          var browY = p[105][1] / crop.k + crop.sy, crownY = st.top, widths = [];
          for (var fy = crownY + (browY - crownY) * 0.45; fy < browY; fy += 2) {
            var e = st.rowExtent(fy);
            if (e) widths.push(e[1] - e[0]);
          }
          widths.sort(function (a, b) { return a - b; });
          face.head = {
            crownPx: Math.round(toCropY(st.top) * 10) / 10,
            widthPx: widths.length ? Math.round(widths[Math.floor(widths.length * 0.8)] * crop.k * 10) / 10 : null,
            hairRgb: st.hairShare > 0.08 ? st.hairRgb : null,
            hairShare: Math.round(st.hairShare * 100) / 100,
            centerPx: Math.round(toCropX(st.cx))
          };
          if (face.head.crownPx < 0) face.head.crownPx = 0; // hair cut off by the top of the frame
        }
        face.portrait = buildPortrait(frame, face, crop, seg, st);
        return { ok: true, face: face };
      }).catch(function () {
        // segmentation is a bonus for the front
        try { if (!face.portrait) face.portrait = buildPortrait(frame, face, crop, null, null); } catch (e) { /* keep the scan */ }
        return { ok: true, face: face };
      });
    });
  }

  /*
   * The live portrait: the full camera frame at up to 960 px wide, with the 478
   * landmarks (and their depth) in its pixel space, a soft person mask and the
   * head outline. The portrait renderer animates this real photo.
   */
  var PORTRAIT_W = 960, MASK_W = 160;
  function buildPortrait(frame, face, crop, seg, st) {
    var s = Math.min(1, PORTRAIT_W / frame.width), W = Math.round(frame.width * s), H = Math.round(frame.height * s);
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, 0, 0, W, H);
    var toP = s / crop.k, r1 = function (v) { return Math.round(v * 10) / 10; };
    var pts = face.points.map(function (p, i) {
      return [r1((p[0] / crop.k + crop.sx) * s), r1((p[1] / crop.k + crop.sy) * s), r1(face.depth[i] * toP)];
    });

    // person mask (anything that isn't background), small and slightly blurred
    var mask = null;
    if (seg) {
      var mw = MASK_W, mh = Math.round(MASK_W * H / W);
      var src = document.createElement('canvas');
      src.width = seg.w; src.height = seg.h;
      var sctx = src.getContext('2d'), img = sctx.createImageData(seg.w, seg.h);
      for (var i = 0; i < seg.cats.length; i++) {
        var v = seg.cats[i] === 0 ? 0 : 255;
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
      }
      sctx.putImageData(img, 0, 0);
      var m = document.createElement('canvas');
      m.width = mw; m.height = mh;
      var mctx = m.getContext('2d');
      mctx.filter = 'blur(1px)';
      mctx.drawImage(src, 0, 0, mw, mh);
      mask = m.toDataURL('image/png');
    }
    var head = st ? { top: r1(st.top * s), bottom: r1(st.bottom * s), left: r1(st.left * s), right: r1(st.right * s) } : null;
    return { photo: c.toDataURL('image/jpeg', 0.92), w: W, h: H, pts: pts, mask: mask, head: head };
  }

  /*
   * Steps 2–4: kind is 'right', 'left' or 'back'.
   * Resolves { ok, view } or { ok: false, reason }.
   */
  function captureView(source, kind) {
    var frame = FM().grab(source);
    return Promise.all([FM().detect(frame), FM().segment(frame)]).then(function (out) {
      var lm = out[0], st = headStats(out[1], frame);
      if (!st) return { ok: false, reason: 'I can\'t see your head. Step back so your whole head is in the frame.' };
      var w = st.right - st.left, h = st.bottom - st.top;
      var facing = st.faceCx == null ? 0 : (st.faceCx - (st.left + st.right) / 2) / (w / 2);

      // with almost no hair (e.g. a shaved head), skin can't tell the face from the back of the head,
      // so only the landmark check can be used
      var littleHair = st.hairShare < 0.15;
      if (kind === 'back') {
        if (lm) return { ok: false, reason: 'I can still see your face. Turn all the way around so the camera sees the back of your head.' };
        if (!littleHair && st.faceShare > 0.3) return { ok: false, reason: 'I can still see your face. Turn all the way around so the camera sees the back of your head.' };
      } else if (!lm && littleHair) {
        // direction can't be verified without hair or a detectable face; accept the capture as taken
      } else {
        // the right side faces the camera when the nose points to the image's left (the preview is mirrored)
        var want = kind === 'right' ? -1 : 1;
        var dir = lm ? noseRatio(lm, frame.width) : facing;
        if (lm && Math.abs(dir) < 0.35) return { ok: false, reason: 'Turn your head further, about 90°, so the camera sees your ' + kind + ' side.' };
        if (!lm && st.faceShare < 0.04) return { ok: false, reason: 'That looks like the back of your head. Turn back a little so the camera sees your ' + kind + ' side.' };
        if (!lm && Math.abs(dir) < 0.12) return { ok: false, reason: 'Turn your head further so the camera sees your ' + kind + ' side.' };
        if (Math.sign(dir) !== want) return { ok: false, reason: 'That shows your ' + (kind === 'right' ? 'left' : 'right') + ' side. Turn the other way.' };
      }

      // crop a square around the head and keep its outline in crop coordinates
      var side = Math.max(w, h) * 1.4, cx = (st.left + st.right) / 2, cy = (st.top + st.bottom) / 2;
      var sx = cx - side / 2, sy = cy - side / 2, k = SIZE / side;
      var c = document.createElement('canvas');
      c.width = SIZE; c.height = SIZE;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#e4e4e7';
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.drawImage(frame, sx, sy, side, side, 0, 0, SIZE, SIZE);
      var r1 = function (v) { return Math.round(v * 10) / 10; };
      return {
        ok: true,
        view: {
          photo: c.toDataURL('image/jpeg', 0.88),
          box: { top: r1((st.top - sy) * k), bottom: r1((st.bottom - sy) * k), left: r1((st.left - sx) * k), right: r1((st.right - sx) * k) },
          faceShare: Math.round(st.faceShare * 100) / 100,
          hairRgb: st.hairRgb
        }
      };
    });
  }

  global.ZoopeHeadScan = { captureFront: captureFront, captureView: captureView, SIZE: SIZE };
})(window);
