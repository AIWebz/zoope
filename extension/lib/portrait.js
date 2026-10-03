/*
 * Live portrait, all on-device.
 *
 * Animates the user's real camera photo instead of a synthetic face. The 478
 * face landmarks (with depth) plus a grid over the rest of the frame form a
 * triangle mesh textured with the photo. The face gets its measured depth and
 * the head a rounded shape, so when the head turns, nods and tilts, near parts
 * (nose, cheeks) move more than far ones, as on a real camera. The jaw drops
 * and the lips part while speaking, the eyelids blink, the eyes make small
 * saccades, the shoulders breathe, and a light sensor grain makes it read as
 * live video. When nothing moves, the picture is exactly the photo.
 */
import * as THREE from './three.module.js';

const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
  148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const IRIS = [[468, 469, 470, 471, 472], [473, 474, 475, 476, 477]];
const UPPER_LIP = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
const LOWER_LIP_INNER = [95, 88, 178, 87, 14, 317, 402, 318, 324];
const INNER_LIP_LOOP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
const EYES = [
  { upper: [246, 161, 160, 159, 158, 157, 173], lower: [7, 163, 144, 145, 153, 154, 155] },
  { upper: [466, 388, 387, 386, 385, 384, 398], lower: [249, 390, 373, 374, 380, 381, 382] }
];

/* Bowyer–Watson Delaunay triangulation of 2D points; returns index triples. */
function delaunay(pts) {
  const n = pts.length, big = 1e5;
  const all = pts.concat([[-big, -big], [big, -big], [0, big]]);
  const circum = (a, b, c) => {
    const [ax, ay] = all[a], [bx, by] = all[b], [cx, cy] = all[c];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    return { a, b, c, x: ux, y: uy, r2: (ax - ux) * (ax - ux) + (ay - uy) * (ay - uy) };
  };
  let tris = [circum(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const [px, py] = all[i], edges = [], keep = [];
    for (const tr of tris) {
      const dx = px - tr.x, dy = py - tr.y;
      if (dx * dx + dy * dy <= tr.r2) edges.push([tr.a, tr.b], [tr.b, tr.c], [tr.c, tr.a]);
      else keep.push(tr);
    }
    // boundary edges are the ones that appear exactly once
    const count = new Map(), key = (e) => Math.min(e[0], e[1]) * 1e6 + Math.max(e[0], e[1]);
    edges.forEach((e) => count.set(key(e), (count.get(key(e)) || 0) + 1));
    edges.forEach((e) => { if (count.get(key(e)) === 1) keep.push(circum(e[0], e[1], i)); });
    tris = keep;
  }
  return tris.filter((t) => t.a < n && t.b < n && t.c < n).map((t) => [t.a, t.b, t.c]);
}

export function has(face) { return !!(face && face.portrait && face.portrait.pts && face.portrait.pts.length >= 468); }
export function supported() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/* Builds the deformable mesh for a portrait. Cached per photo. */
const cache = new Map();
async function build(P) {
  const key = P.photo.length + ':' + P.photo.slice(-48);
  if (cache.has(key)) return cache.get(key);
  const [img, maskImg] = await Promise.all([loadImage(P.photo), P.mask ? loadImage(P.mask) : null]);
  const W = P.w, H = P.h, lm = P.pts, n = lm.length;

  // person mask sampler (1 = person), bilinear
  let person = () => 1;
  if (maskImg) {
    const c = document.createElement('canvas');
    c.width = maskImg.width; c.height = maskImg.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(maskImg, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data, mw = c.width, mh = c.height;
    person = (x, y) => {
      const fx = clamp(x / W * mw - 0.5, 0, mw - 1), fy = clamp(y / H * mh - 0.5, 0, mh - 1);
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(mw - 1, x0 + 1), y1 = Math.min(mh - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
      const v = (xx, yy) => d[(yy * mw + xx) * 4] / 255;
      return (v(x0, y0) * (1 - tx) + v(x1, y0) * tx) * (1 - ty) + (v(x0, y1) * (1 - tx) + v(x1, y1) * tx) * ty;
    };
  }

  // face geometry
  const oval = FACE_OVAL.map((i) => lm[i]);
  const faceL = lm[234][0], faceR = lm[454][0], faceW = faceR - faceL;
  const faceCx = (faceL + faceR) / 2, top = lm[10][1], chin = lm[152][1], faceH = chin - top;
  const ovalCx = oval.reduce((s, p) => s + p[0], 0) / oval.length, ovalCy = oval.reduce((s, p) => s + p[1], 0) / oval.length;

  // head ellipse from the measured outline (hair included), or from the face
  const hd = P.head;
  const headTop = hd ? Math.min(hd.top, top - faceH * 0.15) : top - faceH * 0.45;
  const headL = hd ? Math.min(hd.left, faceL) : faceL - faceW * 0.08, headR = hd ? Math.max(hd.right, faceR) : faceR + faceW * 0.08;
  const hcx = faceCx, hrx = Math.max(faceW * 0.55, (headR - headL) / 2);
  const hcy = (headTop + chin) / 2, hry = (chin - headTop) / 2;
  const hrz = hrx * 0.95;
  const ellZ = (x, y) => { const u = (x - hcx) / hrx, v = (y - hcy) / hry; return -hrz * Math.sqrt(Math.max(0, 1 - u * u - v * v)); };

  // landmark depth, shifted so the face outline sits on the head shape
  const offs = FACE_OVAL.map((i) => ellZ(lm[i][0], lm[i][1]) - lm[i][2]).sort((a, b) => a - b);
  const zOff = offs[offs.length >> 1];

  // points: landmarks, rings around the face, then a grid over the rest of the frame
  const pts = lm.map((p) => [p[0], p[1]]);
  const ringIdx = [];
  [1.12, 1.3].forEach((sc) => {
    oval.forEach((p) => {
      const x = ovalCx + (p[0] - ovalCx) * sc, y = ovalCy + (p[1] - ovalCy) * sc;
      if (x > 1 && x < W - 1 && y > 1 && y < H - 1) { ringIdx.push(pts.length); pts.push([x, y]); }
    });
  });
  const grown = oval.map((p) => [ovalCx + (p[0] - ovalCx) * 1.4, ovalCy + (p[1] - ovalCy) * 1.4]);
  const step = Math.max(W, H) / 44;
  const gx = Math.ceil(W / step), gy = Math.ceil(H / step);
  for (let j = 0; j <= gy; j++) {
    for (let i = 0; i <= gx; i++) {
      const x = Math.min(W, i * W / gx), y = Math.min(H, j * H / gy);
      const edge = i === 0 || j === 0 || i === gx || j === gy;
      if (!edge && insidePolygon(x, y, grown)) continue;
      pts.push([x, y]);
    }
  }
  const tris = delaunay(pts);
  const N = pts.length;

  // per-vertex depth and motion weights
  const z = new Float32Array(N), headW = new Float32Array(N), jawW = new Float32Array(N), bodyW = new Float32Array(N);
  const neckEnd = chin + faceH * 0.55;
  for (let i = 0; i < N; i++) {
    const [x, y] = pts[i];
    if (i < n) { z[i] = lm[i][2] + zOff; headW[i] = 1; continue; }
    const pr = smooth(0.15, 0.6, person(x, y));
    const u = (x - hcx) / (hrx * 1.08), v = (y - hcy) / (hry * 1.08), e = Math.sqrt(u * u + v * v);
    let w = 1 - smooth(0.92, 1.18, e);
    // below the chin the neck takes part of the head's turn
    if (y > chin) w = Math.max(w * (1 - smooth(chin, neckEnd, y)), (1 - smooth(chin, neckEnd, y)) * (1 - smooth(0.6, 1.0, Math.abs(x - hcx) / hrx)));
    headW[i] = w * pr;
    z[i] = e < 1 ? ellZ(x, y) * pr : 0;
    bodyW[i] = y > chin ? smooth(chin, neckEnd + faceH * 0.3, y) * pr : 0;
  }

  // jaw: lower lip and chin follow the jaw; corners partly; upper lip lifts a hair
  const UPPER = new Set(UPPER_LIP), LOWER_IN = new Set(LOWER_LIP_INNER);
  const mouthY = (lm[13][1] + lm[14][1]) / 2;
  for (let i = 0; i < n; i++) {
    const [x, y] = lm[i];
    if (UPPER.has(i)) { jawW[i] = (i === 61 || i === 291 || i === 78 || i === 308) ? 0.35 : -0.06; continue; }
    if (!LOWER_IN.has(i) && y <= mouthY + 0.5) continue;
    const wx = 1 - Math.pow((x - lm[1][0]) / (faceW * 0.55), 2);
    const t = clamp((y - mouthY) / (chin - mouthY), 0, 1);
    jawW[i] = Math.max(0, wx) * (0.7 + 0.3 * t);
  }
  // around the jaw (rings, neck): fade from the nearest jaw-line landmark
  const jawLine = FACE_OVAL.filter((i) => lm[i][1] > mouthY);
  for (let i = n; i < N; i++) {
    const [x, y] = pts[i];
    if (y <= mouthY) continue;
    let best = 1e9, bw = 0;
    jawLine.forEach((k) => { const d = Math.hypot(x - lm[k][0], y - lm[k][1]); if (d < best) { best = d; bw = jawW[k]; } });
    jawW[i] = bw * (1 - smooth(0, faceH * 0.45, best));
  }

  // eyes: points inside an eye (iris) and its upper lid close toward the lower lid
  const eyes = EYES.map((e, k) => {
    const lowerY = e.lower.reduce((s, i) => s + lm[i][1], 0) / e.lower.length;
    const upperY = e.upper.reduce((s, i) => s + lm[i][1], 0) / e.upper.length;
    const loop = e.upper.concat(e.lower.slice().reverse()).map((i) => lm[i]);
    const xs = loop.map((p) => p[0]);
    return { upper: e.upper, lower: e.lower, iris: IRIS[k], lowerY, upperY, loop, width: Math.max(...xs) - Math.min(...xs) };
  });

  const out = {
    img, W, H, pts, tris, z, headW, jawW, bodyW, n, N, faceH, faceW, faceCx, chin, top: headTop, eyes,
    pivot: [faceCx, (lm[234][1] + lm[454][1]) / 2, hrz * 0.35],
    mouthOpenInPhoto: lm[14][1] - lm[13][1] > faceH * 0.02,
    cheeks: [lm[205], lm[425]],
    browSet: new Set([70, 63, 105, 66, 107, 55, 65, 52, 53, 46, 300, 293, 334, 296, 336, 285, 295, 282, 283, 276]),
    mouthC: [(lm[61][0] + lm[291][0]) / 2, (lm[13][1] + lm[14][1]) / 2], mouthW: Math.abs(lm[291][0] - lm[61][0])
  };
  cache.set(key, out);
  return out;
}

/* Vertex and fragment shaders: unlit photo with a touch of sensor grain. */
const VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = `
  uniform sampler2D map; uniform float time; uniform float grain;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec4 c = texture2D(map, vUv);
    float g = hash(gl_FragCoord.xy + fract(time) * 117.0) - 0.5;
    gl_FragColor = vec4(c.rgb + g * grain, c.a);
    #include <colorspace_fragment>
  }`;

/*
 * Renders a live portrait into `canvas` (replaced by a WebGL canvas while it
 * runs). opts: { frame: 'head' | 'bust', onReady(info), onError(err),
 * direct: render into `canvas` itself at opts.size [w, h] (for streaming) }.
 * Returns stop().
 */
export function attach(canvas, face, getLevel, opts = {}) {
  let stopped = false, raf = 0, timer = 0, renderer = null, ro = null;
  const direct = !!opts.direct, id = canvas.id;
  const gl = direct ? canvas : document.createElement('canvas');
  if (!direct) {
    gl.className = canvas.className;
    gl.style.cssText = canvas.style.cssText;
    gl.setAttribute('aria-label', 'Live avatar');
    canvas.style.display = 'none';
    canvas.id = id + '-2d';
    gl.id = id;
    canvas.after(gl);
  }
  gl.dataset.portrait = '1';

  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    if (ro) ro.disconnect();
    if (renderer) { renderer.dispose(); renderer.forceContextLoss(); }
    if (direct) return;
    gl.remove();
    canvas.id = id;
    canvas.style.display = '';
  };
  // rAF stops in background tabs; a stream must keep producing frames, so fall back to a timer there
  const schedule = (fn) => {
    if (direct && document.hidden) timer = setTimeout(() => fn(performance.now()), 1000 / 30);
    else raf = requestAnimationFrame(fn);
  };

  build(face.portrait).then((M) => {
    if (stopped) return;
    renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: false, preserveDrawingBuffer: !!opts.preserve });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x18181b, 1);
    const scene = new THREE.Scene();

    const tex = new THREE.Texture(M.img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = 4;
    tex.needsUpdate = true;

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(M.N * 3), uv = new Float32Array(M.N * 2);
    M.pts.forEach((p, i) => { uv[i * 2] = p[0] / M.W; uv[i * 2 + 1] = 1 - p[1] / M.H; });
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(M.tris.flat());
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, time: { value: 0 }, grain: { value: 0.022 } },
      vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide
    });
    scene.add(new THREE.Mesh(geo, mat));

    // inside of the mouth: drawn on a small canvas each frame, shown on a quad over the lips
    const mc = document.createElement('canvas');
    const mctx = mc.getContext('2d');
    const mtex = new THREE.CanvasTexture(mc);
    mtex.colorSpace = THREE.SRGBColorSpace;
    const mgeo = new THREE.PlaneGeometry(1, 1);
    const mmat = new THREE.ShaderMaterial({
      uniforms: { map: { value: mtex }, time: { value: 0 }, grain: { value: 0.022 } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false
    });
    const mquad = new THREE.Mesh(mgeo, mmat);
    mquad.renderOrder = 2;
    mquad.visible = false;
    scene.add(mquad);

    const camera = new THREE.OrthographicCamera(0, 1, 0, -1, -5000, 5000);
    camera.position.z = 1000;

    // framing: a crop of the photo with the canvas's aspect, never past its edges
    const resize = () => {
      const w = direct ? opts.size[0] : gl.clientWidth || 320, h = direct ? opts.size[1] : gl.clientHeight || 240;
      if (direct) renderer.setPixelRatio(1);
      renderer.setSize(w, h, false);
      const aspect = w / h;
      let vh = opts.frame === 'head' ? Math.min(M.H, (M.chin - M.top) * 1.9) : M.H;
      let vw = vh * aspect;
      if (vw > M.W) { vw = M.W; vh = vw / aspect; }
      const cy = opts.frame === 'head' ? (M.top + M.chin) / 2 + (M.chin - M.top) * 0.08 : M.H / 2;
      const x0 = clamp(M.faceCx - vw / 2, 0, Math.max(0, M.W - vw)), y0 = clamp(cy - vh / 2, 0, Math.max(0, M.H - vh));
      camera.left = x0; camera.right = x0 + vw; camera.top = -y0; camera.bottom = -(y0 + vh);
      camera.updateProjectionMatrix();
    };
    if (!direct) { ro = new ResizeObserver(resize); ro.observe(gl); }
    resize();

    // animation state
    let lastNow = 0, sylAmp = 1, inSyl = false, smileS = 0, idleSmile = 0, nextMood = 0, thinkS = 0;
    let nextPose = 0, poseT = [0, 0, 0], poseC = [0, 0, 0], poseV = [0, 0, 0], browS = 0, browT = 0;
    let mouth = 0, wide = 0, wideS = 0, roundS = 0, teethS = 0, blinkAt = performance.now() + 1600, nextSacc = 0, gaze = [0, 0], gazeT = [0, 0];
    let nod = 0, nodV = 0, lastLevel = 0, talkT = 0;
    const cur = new Float32Array(M.N * 2);
    const [px, py, pz] = M.pivot;

    // 2D deformation (jaw, lips, lids, eyes) in photo space, then head rotation with depth
    const UPPER_SET = new Set(UPPER_LIP);
    const deform = (open, blink) => {
      const drop = M.faceH * 0.046 * Math.pow(open, 1.15);
      const [mcx, mcy] = M.mouthC, mw = M.mouthW;
      // lips: spread for "ee", pulled in and pushed out for "oo", upper lip lifted off the teeth for "f"/"s"
      const sx = 0.17 * wideS - 0.32 * roundS;
      for (let i = 0; i < M.N; i++) {
        let x = M.pts[i][0], y = M.pts[i][1];
        const jw = M.jawW[i];
        if (jw) y += drop * jw;
        if (i < M.n) {
          const dx = (x - mcx) / (mw * 1.15), dy = (y - mcy) / (mw * 0.85), d = Math.sqrt(dx * dx + dy * dy);
          if (d < 1) {
            const f = 1 - smooth(0.35, 1, d);
            x = mcx + (x - mcx) * (1 + sx * f);
            // corners rise a little with a spread, and the lips purse vertically when rounded
            const corner = Math.abs(x - mcx) / (mw * 0.5);
            y -= M.faceH * 0.012 * wideS * f * corner * corner;
            y += (y - mcy) * 0.25 * roundS * f * (1 - corner * 0.6);
            if (UPPER_SET.has(i)) y -= M.faceH * 0.012 * teethS * f;
            // a smile: corners pulled up and out
            if (smileS > 0.01) { x = mcx + (x - mcx) * (1 + 0.07 * smileS * f); y -= M.faceH * 0.024 * smileS * f * corner * corner; }
          }
          // ...and the cheeks rise with it
          if (smileS > 0.01) for (const c of M.cheeks) {
            const cd = Math.hypot(x - c[0], y - c[1]) / (M.faceW * 0.2);
            if (cd < 1) y -= M.faceH * 0.012 * smileS * (1 - smooth(0.2, 1, cd));
          }
        }
        if (M.browSet && M.browSet.has(i)) y -= M.faceH * 0.02 * (M.browLift || 0);
        cur[i * 2] = x; cur[i * 2 + 1] = y;
      }
      M.eyes.forEach((e) => {
        // smiling eyes: the lower lid rises a touch
        if (smileS > 0.01) e.lower.forEach((i) => { cur[i * 2 + 1] -= M.faceH * 0.008 * smileS; });
        const close = 0.92 * blink;
        e.upper.forEach((i) => { cur[i * 2 + 1] = e.lowerY - (e.lowerY - M.pts[i][1]) * (1 - close); });
        e.iris.forEach((i) => {
          cur[i * 2] = M.pts[i][0] + gaze[0] * e.width;
          cur[i * 2 + 1] = e.lowerY - (e.lowerY - (M.pts[i][1] + gaze[1] * e.width)) * (1 - close);
        });
      });
    };

    const frame = (now) => {
      if (stopped) return;
      const s = now / 1000;
      // the voice gives a mouth shape ({ open, wide, round, teeth }) or just a level
      const raw = getLevel ? getLevel() : 0;
      const sh = raw && typeof raw === 'object' ? raw : { open: raw || 0, wide: wide * 0.4, round: 0, teeth: 0 };
      const dt = Math.min(0.1, Math.max(0.001, (now - (lastNow || now)) / 1000)); lastNow = now;
      // natural speech: the jaw opens in ~45 ms and closes in ~90 ms, the lips reshape a bit slower
      // than the jaw (coarticulation), and each syllable opens a slightly different amount
      const target = Math.min(1, Math.max(sh.open || 0, (sh.teeth || 0) * 0.22)) * sylAmp;
      const ease = (tau) => 1 - Math.exp(-dt / tau);
      mouth += (target - mouth) * ease(target > mouth ? 0.045 : 0.09);
      wideS += ((sh.wide || 0) - wideS) * ease(0.11);
      roundS += ((sh.round || 0) - roundS) * ease(0.11);
      teethS += ((sh.teeth || 0) - teethS) * ease(0.06);
      // expression: the line's smile while speaking; while listening it drifts gently, as faces do
      if (now > nextMood) { idleSmile = Math.random() < 0.5 ? 0 : 0.05 + Math.random() * 0.15; nextMood = now + 4000 + Math.random() * 6000; }
      const speakingNow = (sh.open || 0) > 0.02 || s - talkT < 0.8;
      smileS += ((sh.smile != null && (sh.smile > 0 || speakingNow) ? sh.smile : idleSmile) - smileS) * ease(0.4);
      // thinking (the AI is writing a reply): the eyes drift up and aside, the brows lift slightly
      thinkS += ((sh.think ? 1 : 0) - thinkS) * ease(0.25);
      if (thinkS > 0.3 && now > nextSacc) { gazeT = [-0.06, -0.035]; nextSacc = now + 600; }
      const level = mouth;
      if (target > 0.3 && !inSyl) {
        inSyl = true; sylAmp = 0.8 + Math.random() * 0.3;
        // stressed syllables: a small nod and sometimes a brow lift, like a speaker's beat gestures
        if (target > 0.55) { nodV += 0.0035 + Math.random() * 0.004; if (Math.random() < 0.35) browT = 0.6 + Math.random() * 0.4; }
      }
      else if (target < 0.12) inSyl = false;
      if (level > 0.25 && lastLevel <= 0.25) { wide = Math.random(); nodV -= 0.006 + Math.random() * 0.008; talkT = s; }
      lastLevel = level;
      // blinks, a little more often while talking
      let blink = 0;
      if (now > blinkAt) {
        const t = (now - blinkAt) / 150;
        blink = t < 1 ? Math.sin(t * Math.PI) : 0;
        if (t >= 1) blinkAt = now + (s - talkT < 3 ? 1800 : 2600) + Math.random() * 3200;
      }
      // small saccades with a quick move and a hold
      if (now > nextSacc) {
        gazeT = Math.random() < 0.6 ? [0, 0] : [(Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.04];
        nextSacc = now + 700 + Math.random() * 2600;
      }
      gaze[0] += (gazeT[0] - gaze[0]) * 0.35; gaze[1] += (gazeT[1] - gaze[1]) * 0.35;
      // emphasis nods: a damped spring kicked at the start of phrases
      nodV += -nod * 0.02 - nodV * 0.12; nod += nodV;

      // posture: people hold a pose for a few seconds, then shift and settle (a damped spring),
      // with more and bigger shifts while talking; tiny tremor keeps it from looking frozen
      const talking = s - talkT < 1.2;
      if (now > nextPose) {
        const k = talking ? 1 : 0.55;
        poseT = [(Math.random() - 0.5) * 0.09 * k, (Math.random() - 0.5) * 0.05 * k, (Math.random() - 0.5) * 0.045 * k];
        nextPose = now + (talking ? 900 + Math.random() * 1800 : 2200 + Math.random() * 4500);
        // the eyes lead a head turn, then come back to the camera
        if (Math.random() < 0.5) { gazeT = [poseT[0] * 0.9, -poseT[1] * 0.5]; nextSacc = now + 350 + Math.random() * 400; }
      }
      for (let k = 0; k < 3; k++) {
        poseV[k] += ((poseT[k] - poseC[k]) * 22 - poseV[k] * 8.5) * dt;
        poseC[k] += poseV[k] * dt;
      }
      // eyebrows lift on stressed syllables and settle
      browS += ((talking ? browT : thinkS * 0.35) - browS) * (1 - Math.exp(-dt / 0.12));
      browT *= Math.exp(-dt / 0.35);
      M.browLift = browS;
      deform(mouth, blink);
      const tremor = (f, ph) => Math.sin(s * f + ph) * 0.0025;
      const yaw = poseC[0] + tremor(1.7, 0.3) + tremor(2.9, 1.1);
      const pitch = poseC[1] + nod - mouth * 0.012 + tremor(2.3, 2.0);
      const roll = poseC[2] + tremor(1.3, 0.7);
      const breath = Math.sin(s * Math.PI * 2 / 4.6);
      const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);

      for (let i = 0; i < M.N; i++) {
        const w = M.headW[i];
        let x = cur[i * 2], y = cur[i * 2 + 1], zz = M.z[i];
        if (w > 0.001) {
          // rotate about the pivot (y down, z toward the back), blended by the head weight
          let dx = x - px, dy = y - py, dz = zz - pz;
          let rx = dx * cyw + dz * syw, rz = -dx * syw + dz * cyw;                 // yaw
          let ry = dy * cp - rz * sp; rz = dy * sp + rz * cp;                       // pitch
          const qx = rx * cr - ry * sr, qy = rx * sr + ry * cr;                     // roll
          x += (qx + px - x) * w; y += (qy + py - y) * w; zz += (rz + pz - zz) * w;
        }
        y -= breath * 1.1 * (M.bodyW[i] + w * 0.6);
        pos[i * 3] = x; pos[i * 3 + 1] = -y; pos[i * 3 + 2] = -zz;
      }
      geo.attributes.position.needsUpdate = true;
      geo.computeBoundingSphere();

      // mouth interior where the lips have parted
      const gapNow = cur[14 * 2 + 1] - cur[13 * 2 + 1];
      const restGap = M.pts[14][1] - M.pts[13][1];
      if (mouth > 0.03 && gapNow > restGap + 0.6) {
        drawMouth(mctx, mc, M, cur, restGap);
        mtex.needsUpdate = true;
        // the quad sits where the canvas covers, moved like the head (weight 1 at the lips)
        const b = mc._box, cxm = b.x + b.w / 2, cym = b.y + b.h / 2, zm = M.z[13];
        let dx = cxm - px, dy = cym - py, dz = zm - pz;
        let rx = dx * cyw + dz * syw, rz = -dx * syw + dz * cyw;
        let ry = dy * cp - rz * sp; rz = dy * sp + rz * cp;
        const qx = rx * cr - ry * sr, qy = rx * sr + ry * cr;
        mquad.position.set(qx + px, -(qy + py - breath * 0.66), 10);
        mquad.rotation.set(0, 0, -roll);
        mquad.scale.set(b.w * Math.cos(yaw), b.h * Math.cos(pitch), 1);
        mquad.visible = true;
      } else mquad.visible = false;

      mat.uniforms.time.value = s;
      mmat.uniforms.time.value = s;
      renderer.render(scene, camera);
      schedule(frame);
    };
    schedule(frame);
    if (opts.onReady) opts.onReady({ kind: 'portrait', vertices: M.N, triangles: M.tris.length, width: M.W, height: M.H, canvas: gl });
  }).catch((err) => { if (opts.onError) opts.onError(err); stop(); });

  return stop;
}

/* Draws the parted mouth (from the photo when it was open, else a dark cavity with teeth). */
function drawMouth(ctx, c, M, cur, restGap) {
  const loop = INNER_LIP_LOOP;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  loop.forEach((i) => { x0 = Math.min(x0, cur[i * 2]); x1 = Math.max(x1, cur[i * 2]); y0 = Math.min(y0, cur[i * 2 + 1]); y1 = Math.max(y1, cur[i * 2 + 1]); });
  x0 = Math.floor(x0 - 2); y0 = Math.floor(y0 - 2); x1 = Math.ceil(x1 + 2); y1 = Math.ceil(y1 + 2);
  const scale = 3, w = (x1 - x0), h = (y1 - y0);
  if (c.width !== w * scale || c.height !== h * scale) { c.width = w * scale; c.height = h * scale; }
  c._box = { x: x0, y: y0, w, h };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
  const path = (pts) => {
    ctx.beginPath();
    loop.forEach((i, j) => { const x = pts(i, 0), y = pts(i, 1); if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath();
  };
  const C = (i, k) => cur[i * 2 + k];
  ctx.save();
  path(C);
  ctx.clip();
  // depth of the cavity: dark, warmer near the lips
  const midX = (C(78, 0) + C(308, 0)) / 2, midY = (C(13, 1) + C(14, 1)) / 2;
  const g = ctx.createRadialGradient(midX, midY, 0, midX, midY, (C(308, 0) - C(78, 0)) * 0.55);
  g.addColorStop(0, '#1a0708'); g.addColorStop(0.7, '#2c0d0f'); g.addColorStop(1, '#4a1a1c');
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, w, h);
  const gap = C(14, 1) - C(13, 1), mw = C(308, 0) - C(78, 0);
  if (restGap > M.faceH * 0.02) {
    // the photo had an open mouth: its upper half stays with the upper teeth, the lower half drops with the jaw
    const R = (i, k) => M.pts[i][k];
    const rmid = (R(13, 1) + R(14, 1)) / 2;
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w, rmid - y0); ctx.clip();
    ctx.drawImage(M.img, 0, 0); ctx.restore();
    ctx.save(); ctx.translate(0, C(14, 1) - R(14, 1)); ctx.beginPath(); ctx.rect(x0, rmid, w, h); ctx.clip();
    ctx.drawImage(M.img, 0, 0); ctx.restore();
  } else {
    // upper teeth just under the lip, in shadow at the corners
    const ty = Math.min(C(13, 1), C(82, 1), C(312, 1));
    const th = Math.min(gap * 0.42, M.faceH * 0.03);
    const tg = ctx.createLinearGradient(C(78, 0), 0, C(308, 0), 0);
    tg.addColorStop(0, 'rgba(120,105,95,0)'); tg.addColorStop(0.22, 'rgba(214,206,194,.92)');
    tg.addColorStop(0.5, 'rgba(236,230,220,.96)'); tg.addColorStop(0.78, 'rgba(214,206,194,.92)'); tg.addColorStop(1, 'rgba(120,105,95,0)');
    ctx.fillStyle = tg;
    ctx.fillRect(C(78, 0), ty - 1, mw, th + 1);
    // a faint line between the front teeth and a soft shadow under the upper lip
    ctx.fillStyle = 'rgba(90,70,60,.25)';
    ctx.fillRect(midX - 0.25, ty, 0.5, th * 0.9);
    const sh = ctx.createLinearGradient(0, ty - 1, 0, ty + th * 0.6);
    sh.addColorStop(0, 'rgba(40,15,15,.55)'); sh.addColorStop(1, 'rgba(40,15,15,0)');
    ctx.fillStyle = sh; ctx.fillRect(x0, ty - 1, w, th * 0.6);
    // tongue at the bottom when the mouth is open wider
    if (gap > M.faceH * 0.025) {
      ctx.fillStyle = 'rgba(150,62,68,.6)';
      ctx.beginPath();
      ctx.ellipse(midX, C(14, 1) + gap * 0.05, mw * 0.3, gap * 0.32, 0, Math.PI, 0);
      ctx.fill();
    }
  }
  ctx.restore();
  // soften the edge where the cavity meets the lips
  ctx.save();
  path(C);
  ctx.strokeStyle = 'rgba(60,20,22,.45)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.restore();
}
