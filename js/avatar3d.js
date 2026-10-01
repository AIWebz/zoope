/*
 * 3D avatar generation, all on-device.
 *
 * Builds a real 3D head from a four-view head scan (front, right, left, back).
 * The 478 MediaPipe landmarks (with depth) become the face surface; a skull
 * shell sized from the measured head outline closes it into a full head, and
 * each part is textured from the capture that saw it best. A neck and
 * shoulders complete the bust.
 * The model is rendered with WebGL (three.js), animated (jaw, lips, blinks,
 * head motion) and can be exported as a .glb file.
 */
import * as THREE from '../vendor/three/three.module.js';
import { GLTFExporter } from '../vendor/three/GLTFExporter.js';

// MediaPipe face-mesh landmark indices
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
  148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const SHELL_RINGS = 12;

function mesh() { return window.ZoopeFaceMesh; }

/* -------------------------------- helpers -------------------------------- */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function sampler(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const W = c.width, H = c.height;
  // median colour of a box, in 0..1 linear-ish sRGB
  return function (x0, y0, x1, y1, pct) {
    const r = [], g = [], b = [];
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, y1); y += 2) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, x1); x += 2) {
        const i = (y * W + x) * 4;
        r.push(data[i]); g.push(data[i + 1]); b.push(data[i + 2]);
      }
    }
    if (!r.length) return new THREE.Color(0.6, 0.5, 0.45);
    // pick the pixel at the given brightness percentile (default: median)
    const order = r.map((_, i) => i).sort((i, j) => (r[i] + g[i] + b[i]) - (r[j] + g[j] + b[j]));
    const k = order[Math.min(order.length - 1, Math.floor(order.length * (pct == null ? 0.5 : pct)))];
    return new THREE.Color().setRGB(r[k] / 255, g[k] / 255, b[k] / 255, THREE.SRGBColorSpace);
  };
}

function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function slerp(a, b, t) {
  const dot = Math.min(1, Math.max(-1, a.dot(b)));
  const theta = Math.acos(dot) * t;
  const rel = b.clone().sub(a.clone().multiplyScalar(dot));
  if (rel.lengthSq() < 1e-9) return a.clone();
  rel.normalize();
  return a.clone().multiplyScalar(Math.cos(theta)).add(rel.multiplyScalar(Math.sin(theta)));
}

/* ------------------------------ texture atlas ------------------------------ */
// One texture holds every capture, so the whole head renders with one material.
//   tile 0: front photo, cleaned outside the face outline (for the face surface)
//   tile 1: front photo, untouched (for the hairline and crown)
//   tile 2: right side · tile 3: left side · tile 4: back
const TILE = 512, ATLAS_COLS = 3, ATLAS_ROWS = 2;
const TILES = { faceClean: 0, front: 1, right: 2, left: 3, back: 4 };

function tileUV(tile, px, py, size) {
  const tx = (tile % ATLAS_COLS) * TILE, ty = Math.floor(tile / ATLAS_COLS) * TILE;
  return [(tx + (px / size) * TILE) / (TILE * ATLAS_COLS), 1 - (ty + (py / size) * TILE) / (TILE * ATLAS_ROWS)];
}

// Views of the head, as directions from the head towards the camera, and the
// rotation (about the vertical axis) that turns each view to face the camera.
const VIEWS = {
  front: { dir: new THREE.Vector3(0, 0, 1), angle: 0 },
  right: { dir: new THREE.Vector3(1, 0, 0), angle: -Math.PI / 2 },
  left: { dir: new THREE.Vector3(-1, 0, 0), angle: Math.PI / 2 },
  back: { dir: new THREE.Vector3(0, 0, -1), angle: Math.PI }
};

/* ------------------------------ model building ------------------------------ */
// Turns a scan into a description of the head: positions, uvs, triangles,
// measured shape, animation weights and colours. Cached per face.
const specCache = new WeakMap();

function buildSpec(face, img) {
  if (specCache.has(face)) return specCache.get(face);
  const FM = mesh();
  const SIZE = FM.SIZE;
  const p = face.points, z = face.depth;
  const n = p.length;
  const top = p[10], chin = p[152];
  const faceH = chin[1] - top[1];
  const cx = (p[454][0] + p[234][0]) / 2, cy = (top[1] + chin[1]) / 2;
  const S = faceH;

  // face vertices in head space: x right, y up, z toward the camera, face height = 1
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (p[i][0] - cx) / S;
    pos[i * 3 + 1] = -(p[i][1] - cy) / S;
    pos[i * 3 + 2] = -z[i] / S;
    const t = tileUV(TILES.faceClean, p[i][0], p[i][1], SIZE);
    uv[i * 2] = t[0]; uv[i * 2 + 1] = t[1];
  }

  // triangulate the face surface, leaving the mouth opening as a hole
  const lipPoly = FM.INNER_LIP_LOOP.map((i) => p[i]);
  const midY = (p[13][1] + p[14][1]) / 2;
  const tris = [], mouthTris = [];
  FM.delaunay(p.map((q) => [q[0], q[1]])).forEach((t) => {
    const a = p[t[0]], b = p[t[1]], c = p[t[2]];
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    if (area < 0.3) return;
    const gx = (a[0] + b[0] + c[0]) / 3, gy = (a[1] + b[1] + c[1]) / 3;
    // the lips' opening is rebuilt below as a grid, so it can split cleanly along the lip line
    if (insidePolygon(gx, gy, lipPoly)) return;
    // wind every triangle so its normal points out of the face (toward +z)
    const ax = pos[t[0] * 3], ay = pos[t[0] * 3 + 1];
    const cross = (pos[t[1] * 3] - ax) * (pos[t[2] * 3 + 1] - ay) - (pos[t[1] * 3 + 1] - ay) * (pos[t[2] * 3] - ax);
    tris.push(cross < 0 ? [t[0], t[2], t[1]] : t);
  });
  // mouth-interior grid in photo space; rows meet exactly at the lip line
  const lx = Math.min(...lipPoly.map((q) => q[0])) - 2, rx = Math.max(...lipPoly.map((q) => q[0])) + 2;
  const ty = Math.min(...lipPoly.map((q) => q[1])) - 2, by = Math.max(...lipPoly.map((q) => q[1])) + 2;
  const lipZ = (z[13] + z[14] + z[78] + z[308]) / 4;
  const COLS = 28, ROWS = 8;
  const cell = (x0, y0, x1, y1, lower) => {
    if (!insidePolygon((x0 + x1) / 2, (y0 + y1) / 2, lipPoly)) return;
    mouthTris.push({ lower, quad: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
  };
  for (let half = 0; half < 2; half++) {
    const y0 = half ? midY : ty, y1 = half ? by : midY;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const a = lx + (rx - lx) * c / COLS, b = lx + (rx - lx) * (c + 1) / COLS;
        cell(a, y0 + (y1 - y0) * r / ROWS, b, y0 + (y1 - y0) * (r + 1) / ROWS, half === 1);
      }
    }
  }
  const toHead = (x, y) => [(x - cx) / S, -(y - cy) / S, -(lipZ / S) - 0.012];
  const mouthOpenInPhoto = (p[14][1] - p[13][1]) > 3;

  // jaw weights: how much each point follows the lower jaw
  const upper = new Set(FM.UPPER_LIP), lowerInner = new Set(FM.LOWER_LIP_INNER);
  const mouthY = (p[13][1] + p[14][1]) / 2;
  const faceW = p[454][0] - p[234][0];
  const jaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (upper.has(i)) { jaw[i] = (i === 61 || i === 291 || i === 78 || i === 308) ? 0.35 : -0.06; continue; }
    if (!lowerInner.has(i) && p[i][1] <= mouthY + 0.5) continue;
    const wx = 1 - Math.pow((p[i][0] - p[1][0]) / (faceW * 0.55), 2);
    const t = Math.max(0, Math.min(1, (p[i][1] - mouthY) / (chin[1] - mouthY)));
    jaw[i] = Math.max(0, wx) * (0.75 + 0.25 * t);
  }

  // colours sampled from the photo; hair from the segmentation when the scan measured it
  const sample = sampler(img);
  const skin = sample(p[205][0] - 6, p[205][1] - 6, p[205][0] + 6, p[205][1] + 6)
    .lerp(sample(p[425][0] - 6, p[425][1] - 6, p[425][0] + 6, p[425][1] + 6), 0.5);
  const head = face.head || {};
  const rgb = (a) => new THREE.Color().setRGB(a[0] / 255, a[1] / 255, a[2] / 255, THREE.SRGBColorSpace);
  const hair = head.hairRgb ? rgb(head.hairRgb)
    : sample(top[0] - faceW * 0.2, top[1] - faceH * 0.2, top[0] + faceW * 0.2, top[1] - faceH * 0.06, 0.3);
  const shY = Math.min(SIZE * 0.93, chin[1] + faceH * 0.42);
  const innerY = Math.min(SIZE - 6, chin[1] + faceH * 0.3);
  const inner = sample(cx - faceW * 0.1, innerY - 5, cx + faceW * 0.1, innerY + 5);
  const shirt = sample(cx - faceW * 0.95, shY - 8, cx - faceW * 0.55, shY + 8)
    .lerp(sample(cx + faceW * 0.55, shY - 8, cx + faceW * 0.95, shY + 8), 0.5);
  const ovalColors = FACE_OVAL.map((i) => {
    const x = p[i][0] + (cx - p[i][0]) * 0.06, y = p[i][1] + (cy - p[i][1]) * 0.06;
    return sample(x - 3, y - 3, x + 3, y + 3);
  });

  // shape measured by the scan (null when a step is missing or the reading is implausible)
  const chinY = pos[152 * 3 + 1];
  const crownY = head.crownPx > 2 ? (cy - head.crownPx) / S : null;
  const width = head.widthPx ? head.widthPx / S : null;
  let depth = null;
  const views = face.views || {};
  const sideDepths = ['right', 'left'].filter((k) => views[k] && views[k].box && crownY != null).map((k) => {
    const b = views[k].box;
    const scale = (b.bottom - b.top) / (crownY - chinY); // crop px per head unit in that photo
    return (b.right - b.left) / scale;
  });
  if (sideDepths.length) depth = sideDepths.reduce((a, b) => a + b, 0) / sideDepths.length;

  const spec = {
    n, pos, uv, tris, mouthTris, toHead, SIZE, mouthOpenInPhoto, jaw, S, cx, cy,
    mouth: { x: (pos[78 * 3] + pos[308 * 3]) / 2, y: (pos[13 * 3 + 1] + pos[14 * 3 + 1]) / 2, z: Math.min(pos[13 * 3 + 2], pos[14 * 3 + 2]), w: Math.abs(pos[308 * 3] - pos[78 * 3]) },
    eyes: FM.EYES.map((e) => ({
      upper: e.upper,
      lowerY: e.lower.reduce((s, i) => s + pos[i * 3 + 1], 0) / e.lower.length,
      lowerZ: e.lower.reduce((s, i) => s + pos[i * 3 + 2], 0) / e.lower.length
    })),
    chinY,
    measured: { crownY, width, depth },
    views: Object.keys(views).filter((k) => views[k] && views[k].photo),
    colors: { skin, hair, shirt, inner, oval: ovalColors }, hairShare: head.hairShare == null ? 0.3 : head.hairShare
  };
  specCache.set(face, spec);
  return spec;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Skull shell: rings sweep from the face outline over and behind the head.
// Its size comes from the scan when measured (crown height, head width, head depth).
function buildShell(spec) {
  const ring0 = FACE_OVAL.map((i) => new THREE.Vector3(spec.pos[i * 3], spec.pos[i * 3 + 1], spec.pos[i * 3 + 2]));
  const minX = Math.min(...ring0.map((v) => v.x)), maxX = Math.max(...ring0.map((v) => v.x));
  const meanZ = ring0.reduce((s, v) => s + v.z, 0) / ring0.length;
  let noseZ = -Infinity;
  for (let i = 0; i < spec.n; i++) noseZ = Math.max(noseZ, spec.pos[i * 3 + 2]);

  const C = new THREE.Vector3((minX + maxX) / 2, 0.12, meanZ - 0.3);
  const R = new THREE.Vector3((maxX - minX) / 2 * 1.12, 0.67, 0.64);
  const m = spec.measured;
  if (m.width) R.x = clamp(m.width / 2 / 1.03, R.x * 0.85, R.x * 1.3);
  if (m.crownY) R.y = clamp((m.crownY - C.y) / 1.04, 0.5, 0.9);
  if (m.depth) {
    const D = clamp(m.depth, 0.95, 1.5);
    R.z = clamp(D * 0.47, 0.5, 0.8);
    C.z = noseZ - D + R.z;
  }

  const back = new THREE.Vector3(0, 0.3, -1).normalize();
  const count = ring0.length;
  const positions = [], colors = [], index = [], hairW = [];
  const hair = spec.colors.hair, skinDark = spec.colors.skin.clone().multiplyScalar(0.82);

  for (let k = 0; k <= SHELL_RINGS; k++) {
    const t = k / SHELL_RINGS;
    for (let i = 0; i < count; i++) {
      let v;
      if (k === 0) v = ring0[i];
      else {
        const rel = ring0[i].clone().sub(C).divide(R);
        const f = rel.length(); // how far this outline point sits from the ellipsoid (1 = on it)
        const d = rel.normalize();
        const s = slerp(d, back, t);
        const ease = Math.min(1, t * 2.5), smooth = ease * ease * (3 - 2 * ease);
        const radial = f + (1 - f) * smooth; // start on the outline, settle onto the skull
        const puff = 1 + 0.08 * Math.max(0, s.y) * Math.sin(Math.PI * Math.min(1, t * 1.4));
        v = C.clone().add(s.clone().multiply(R).multiplyScalar(puff * radial));
        v.x = C.x + (v.x - C.x) * (1 + 0.1 * Math.max(0, s.y)); // fuller temples and crown
      }
      positions.push(v.x, v.y, v.z);
      const dir = ring0[i].clone().sub(C).normalize();
      const target = dir.y > -0.25 ? hair : skinDark;
      const speed = dir.y > 0.35 ? 9 : 2.4;
      const c = spec.colors.oval[i].clone().lerp(target, Math.min(1, t * speed));
      colors.push(c.r, c.g, c.b);
      // how much hair grows here: none on the face outline and below the ears
      hairW.push(dir.y > -0.25 ? Math.min(1, t * speed * 0.8) * Math.min(1, (dir.y + 0.25) * 3) : 0);
    }
  }
  for (let k = 0; k < SHELL_RINGS; k++) {
    for (let i = 0; i < count; i++) {
      const a = k * count + i, b = k * count + (i + 1) % count, c = (k + 1) * count + i, d = (k + 1) * count + (i + 1) % count;
      index.push(a, c, b, b, c, d);
    }
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors), hairW: new Float32Array(hairW), index, center: C, radii: R, ringSize: count };
}

// Maps a head-space point into a captured photo (crop pixels), for each view.
// Side and back photos are aligned by fitting the model's silhouette to the
// head outline found in the photo.
function makeProjectors(spec, shell, faceInfo) {
  const proj = {
    front: (v) => [spec.cx + v.x * spec.S, spec.cy - v.y * spec.S]
  };
  const all = [];
  for (let i = 0; i < spec.n; i++) all.push([spec.pos[i * 3], spec.pos[i * 3 + 1], spec.pos[i * 3 + 2]]);
  for (let i = 0; i < shell.positions.length; i += 3) all.push([shell.positions[i], shell.positions[i + 1], shell.positions[i + 2]]);
  const ymax = Math.max(...all.map((q) => q[1]));
  ['right', 'left', 'back'].forEach((k) => {
    const view = faceInfo.views && faceInfo.views[k];
    if (!view || !view.box) return;
    const a = VIEWS[k].angle, ca = Math.cos(a), sa = Math.sin(a);
    const xs = all.map((q) => q[0] * ca + q[2] * sa);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const b = view.box, s = (b.right - b.left) / (xmax - xmin);
    proj[k] = (v) => [b.left + (v.x * ca + v.z * sa - xmin) * s, b.top + (ymax - v.y) * s];
  });
  return proj;
}

// How much each view should contribute at a surface point with normal n.
function viewWeights(n, available, sharp) {
  const w = [0, 0, 0, 0];
  ['front', 'right', 'left', 'back'].forEach((k, i) => {
    if (!available.includes(k)) return;
    const d = n.dot(VIEWS[k].dir);
    w[i] = d > 0.1 ? Math.pow(d - 0.1, sharp) : 0;
  });
  return w;
}

// Standard (lit) material whose colour blends up to four photos of the atlas
// by per-vertex weights, falling back to a per-vertex colour where no photo saw
// the surface.
function blendMaterial(texture) {
  const mat = new THREE.MeshPhysicalMaterial({
    roughness: 0.62, metalness: 0, side: THREE.DoubleSide,
    sheen: 0.18, sheenRoughness: 0.6, sheenColor: new THREE.Color(0.75, 0.45, 0.4),
    clearcoat: 0.06, clearcoatRoughness: 0.5
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.atlas = { value: texture };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 uvF; attribute vec2 uvR; attribute vec2 uvL; attribute vec2 uvB;
        attribute vec4 vw; attribute vec3 vcol;
        varying vec2 vUvF; varying vec2 vUvR; varying vec2 vUvL; varying vec2 vUvB;
        varying vec4 vW; varying vec3 vCol;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vUvF = uvF; vUvR = uvR; vUvL = uvL; vUvB = uvB; vW = vw; vCol = vcol;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D atlas;
        varying vec2 vUvF; varying vec2 vUvR; varying vec2 vUvL; varying vec2 vUvB;
        varying vec4 vW; varying vec3 vCol;`)
      .replace('#include <map_fragment>', `
        float wsum = vW.x + vW.y + vW.z + vW.w;
        vec3 tex = texture2D(atlas, vUvF).rgb * vW.x + texture2D(atlas, vUvR).rgb * vW.y
                 + texture2D(atlas, vUvL).rgb * vW.z + texture2D(atlas, vUvB).rgb * vW.w;
        tex /= max(wsum, 1e-4);
        diffuseColor.rgb = mix(vCol, tex, clamp(wsum * 3.0, 0.0, 1.0));`);
  };
  return mat;
}

// Fills the view attributes (uvs + weights) of a geometry from its rest positions/normals.
function addViewAttributes(geo, pts, normals, proj, available, opts) {
  const count = pts.length / 3;
  const uvs = { F: new Float32Array(count * 2), R: new Float32Array(count * 2), L: new Float32Array(count * 2), B: new Float32Array(count * 2) };
  const vw = new Float32Array(count * 4);
  const v = new THREE.Vector3(), nrm = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.set(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    nrm.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]).normalize();
    const w = viewWeights(nrm, available, opts.sharp);
    if (opts.frontBoost) w[0] = Math.max(w[0] * opts.frontBoost, opts.frontFloor || 0);
    if (opts.frontOK && !opts.frontOK(v)) w[0] = 0;
    [['F', 'front'], ['R', 'right'], ['L', 'left'], ['B', 'back']].forEach(([key, view], k) => {
      if (!proj[view]) { w[k] = 0; return; }
      const px = view === 'front' && opts.frontUV ? null : proj[view](v);
      const t = px ? tileUV(view === 'front' ? TILES.front : TILES[view], px[0], px[1], opts.SIZE)
        : [opts.frontUV[i * 2], opts.frontUV[i * 2 + 1]];
      uvs[key][i * 2] = t[0]; uvs[key][i * 2 + 1] = t[1];
    });
    vw.set(w, i * 4);
  }
  geo.setAttribute('uvF', new THREE.BufferAttribute(uvs.F, 2));
  geo.setAttribute('uvR', new THREE.BufferAttribute(uvs.R, 2));
  geo.setAttribute('uvL', new THREE.BufferAttribute(uvs.L, 2));
  geo.setAttribute('uvB', new THREE.BufferAttribute(uvs.B, 2));
  geo.setAttribute('vw', new THREE.BufferAttribute(vw, 4));
}

/*
 * Hair as real 3D layers: stacked shells over the scalp, each a little further
 * out, cut into strands by a strand texture. Inner layers are darker (light
 * reaches them less), outer layers thinner and lighter, so the hair has volume
 * and a ragged, strand-by-strand edge in silhouette.
 */
const HAIR_LAYERS = 16;
let strandTex = null;
function strands() {
  if (strandTex) return strandTex;
  const W = 256, H = 64, data = new Uint8Array(W * H * 4);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const len = [];
  for (let x = 0; x < W; x++) len.push(rnd());
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // each column is a strand clump; its height says how far out it reaches, varying slowly along its length
      const v = Math.max(0, Math.min(1, len[x] * 0.8 + 0.2 * Math.sin(y / H * Math.PI * 2 + x * 1.7)));
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(v * 255); data[i + 3] = 255;
    }
  }
  strandTex = new THREE.DataTexture(data, W, H);
  strandTex.wrapS = strandTex.wrapT = THREE.RepeatWrapping;
  strandTex.magFilter = THREE.NearestFilter;
  strandTex.needsUpdate = true;
  return strandTex;
}
function buildHairLayers(shell, hairColor) {
  const P = shell.positions, W = shell.hairW, count = shell.ringSize, rings = SHELL_RINGS;
  const keep = [];
  for (let t = 0; t < shell.index.length; t += 3) {
    const a = shell.index[t], b = shell.index[t + 1], c = shell.index[t + 2];
    if (W[a] > 0.15 && W[b] > 0.15 && W[c] > 0.15) keep.push(a, b, c);
  }
  const group = new THREE.Group();
  group.name = 'hair';
  if (!keep.length) return group;
  const uv = new Float32Array((P.length / 3) * 2);
  for (let k = 0; k <= rings; k++) for (let i = 0; i < count; i++) { const v = k * count + i; uv[v * 2] = i / count * 9; uv[v * 2 + 1] = k / rings; }
  const thick = 0.075;
  for (let L = 1; L <= HAIR_LAYERS; L++) {
    const f = L / HAIR_LAYERS, pos = new Float32Array(P.length);
    for (let v = 0; v < P.length / 3; v++) {
      const d = new THREE.Vector3(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]).sub(shell.center).normalize();
      const out = thick * f * W[v];
      // strands fall back and slightly down as they leave the scalp
      pos[v * 3] = P[v * 3] + d.x * out;
      pos[v * 3 + 1] = P[v * 3 + 1] + d.y * out - out * 0.25 * f;
      pos[v * 3 + 2] = P[v * 3 + 2] + d.z * out - out * 0.2 * f;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(keep);
    g.computeVertexNormals();
    const shade = 0.5 + 0.6 * f;
    const mat = new THREE.MeshStandardMaterial({
      color: hairColor.clone().multiplyScalar(shade), roughness: 0.55 - 0.15 * f, metalness: 0,
      alphaMap: strands(), alphaTest: 0.08 + f * 0.82, transparent: false, side: THREE.DoubleSide
    });
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = L;
    group.add(m);
  }
  return group;
}

/*
 * Clothing in layers: the shirt (colour from under the chin), a collar that
 * stands around the neck, and an open jacket or top layer over it (colour from
 * the shoulders), with lapels and soft folds.
 */
function buildClothing(spec, shell) {
  const group = new THREE.Group();
  group.name = 'shoulders';
  const outerC = spec.colors.shirt, innerC = spec.colors.inner || spec.colors.shirt;
  const layered = outerC.clone().sub(innerC).r ** 2 + outerC.clone().sub(innerC).g ** 2 + outerC.clone().sub(innerC).b ** 2 > 0.004;
  const fabric = (c, rough) => new THREE.MeshPhysicalMaterial({ color: c, roughness: rough, metalness: 0, sheen: 0.6, sheenRoughness: 0.8, sheenColor: c.clone().lerp(new THREE.Color(1, 1, 1), 0.3), side: THREE.DoubleSide });
  const baseY = spec.chinY - 0.64, cx = shell.center.x, cz = shell.center.z + 0.02;

  // body under the clothes: a rounded torso with shoulders, slightly flattened
  const torsoShape = (rx, ry, rz, phiStart, phiLen, folds) => {
    const g = new THREE.SphereGeometry(1, 64, 28, phiStart, phiLen, 0, Math.PI / 2);
    const a = g.attributes.position;
    for (let i = 0; i < a.count; i++) {
      let x = a.getX(i), y = a.getY(i), z = a.getZ(i);
      // squarer shoulders: push the upper sides out
      const sq = 1 + 0.18 * Math.max(0, y) * Math.abs(x);
      // fabric folds: low-frequency ripples, strongest at the sides
      const fold = folds ? 0.012 * Math.sin(x * 14 + y * 5) * (1 - y) : 0;
      a.setXYZ(i, x * sq * (1 + fold), y, z * (1 + fold));
    }
    g.computeVertexNormals();
    g.scale(rx, ry, rz);
    return g;
  };
  const shirt = new THREE.Mesh(torsoShape(1.24, 0.5, 0.52, 0, Math.PI * 2, false), fabric(layered ? innerC : outerC, 0.85));
  shirt.position.set(cx, baseY, cz);
  group.add(shirt);

  // collar: a short open band standing around the base of the neck
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.36, 0.13, 40, 1, true, Math.PI * 0.18, Math.PI * 1.64), fabric(innerC.clone().multiplyScalar(1.04), 0.8));
  collar.position.set(cx, spec.chinY - 0.2, shell.center.z + 0.06);
  collar.rotation.y = Math.PI;
  group.add(collar);

  if (layered) {
    // the outer layer, open at the front so the shirt shows through
    const gap = 0.55;
    const jacket = new THREE.Mesh(torsoShape(1.3, 0.54, 0.58, Math.PI / 2 + gap / 2, Math.PI * 2 - gap, true), fabric(outerC, 0.9));
    jacket.position.set(cx, baseY - 0.01, cz);
    group.add(jacket);
    // lapels folded back along the opening
    [-1, 1].forEach((side) => {
      const lapel = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.42, 0.015), fabric(outerC.clone().multiplyScalar(0.92), 0.85));
      lapel.position.set(cx + side * 0.2, baseY + 0.3, cz + 0.5);
      lapel.rotation.set(-0.5, side * -0.35, side * 0.42);
      group.add(lapel);
    });
  }
  return group;
}

function buildHead(spec, texture, faceInfo) {
  const group = new THREE.Group();
  group.name = 'zoope-avatar';
  const available = ['front'].concat(spec.views.filter((k) => VIEWS[k]));
  const hasSides = available.includes('right') || available.includes('left');
  const blendMat = blendMaterial(texture);
  const plainMat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.78, metalness: 0, side: THREE.DoubleSide });

  const shell = buildShell(spec);
  const proj = makeProjectors(spec, shell, faceInfo);

  // face surface (indexed, smooth); its vertices are animated in pose()
  const faceGeo = new THREE.BufferGeometry();
  faceGeo.setAttribute('position', new THREE.BufferAttribute(spec.pos.slice(), 3));
  faceGeo.setIndex(spec.tris.flat());
  faceGeo.computeVertexNormals();
  faceGeo.setAttribute('uv', new THREE.BufferAttribute(spec.uv, 2));
  // where no photo faces a steep part of the face, fall back to the person's own skin tone
  const skinLin = spec.colors.skin, faceCol = new Float32Array(spec.n * 3);
  for (let i = 0; i < spec.n; i++) faceCol.set([skinLin.r, skinLin.g, skinLin.b], i * 3);
  faceGeo.setAttribute('vcol', new THREE.BufferAttribute(faceCol, 3));
  // the front photo dominates the face; side photos take over only on steep cheeks
  addViewAttributes(faceGeo, spec.pos, faceGeo.attributes.normal.array, proj, available, { sharp: 3, frontBoost: 6, frontFloor: 0.08, frontUV: spec.uv, SIZE: spec.SIZE });
  const faceMesh = new THREE.Mesh(faceGeo, blendMat);
  faceMesh.name = 'face';

  // skull: blended from whichever captures saw it, plain hair/skin colour where none did
  const shellGeo = new THREE.BufferGeometry();
  shellGeo.setAttribute('position', new THREE.BufferAttribute(shell.positions.slice(), 3));
  shellGeo.setIndex(shell.index);
  shellGeo.computeVertexNormals();
  const ellN = new Float32Array(shell.positions.length);
  for (let i = 0; i < shell.positions.length; i += 3) {
    const n = new THREE.Vector3(shell.positions[i], shell.positions[i + 1], shell.positions[i + 2])
      .sub(shell.center).divide(shell.radii).divide(shell.radii).normalize();
    ellN[i] = n.x; ellN[i + 1] = n.y; ellN[i + 2] = n.z;
  }
  shellGeo.setAttribute('vcol', new THREE.BufferAttribute(shell.colors, 3));
  addViewAttributes(shellGeo, shell.positions, ellN, proj, available, {
    sharp: 2, SIZE: spec.SIZE,
    // the front photo only helps where it shows the head (hairline, temples), not below the chin
    frontOK: (v) => { const px = proj.front(v); return v.y > spec.chinY + 0.1 && px[0] > 2 && px[0] < spec.SIZE - 2 && px[1] > 2; }
  });
  const shellMesh = new THREE.Mesh(shellGeo, blendMat);
  shellMesh.name = 'head';

  const skin = spec.colors.skin;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.34, 0.5, 32, 1, true),
    new THREE.MeshStandardMaterial({ color: skin.clone().multiplyScalar(0.86), roughness: 0.85, side: THREE.DoubleSide }));
  neck.position.set(shell.center.x, spec.chinY - 0.1, shell.center.z + 0.06);
  neck.name = 'neck';

  const torso = buildClothing(spec, shell);
  const hairLayers = spec.hairShare > 0.06 ? buildHairLayers(shell, spec.colors.hair) : null;

  // the photo's own mouth interior, split so the jaw can open it
  const mouthPieces = [false, true].map((lower) => {
    const list = spec.mouthTris.filter((mt) => mt.lower === lower);
    if (!list.length) return null;
    const verts = [], uvs = [];
    list.forEach(({ quad }) => [0, 1, 2, 0, 2, 3].forEach((k) => {
      const q = quad[k], h = spec.toHead(q[0], q[1]);
      verts.push(h[0], h[1], h[2]);
      uvs.push(...tileUV(TILES.faceClean, q[0], q[1], spec.SIZE));
    }));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.computeVertexNormals();
    const piece = new THREE.Mesh(g, plainMat);
    piece.userData = { lower, rest: Float32Array.from(verts) };
    return piece;
  }).filter(Boolean);

  // inside of the mouth, seen through the lip opening
  const mo = spec.mouth;
  const cavity = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshStandardMaterial({ color: 0x2a0d10, roughness: 1 }));
  cavity.scale.set(mo.w * 0.5, 0.12, 0.08);
  cavity.position.set(mo.x, mo.y - 0.04, mo.z - 0.15);
  const teethMat = new THREE.MeshStandardMaterial({ color: 0xece6dc, roughness: 0.45 });
  const upperTeeth = new THREE.Mesh(new THREE.BoxGeometry(mo.w * 0.62, 0.034, 0.03), teethMat);
  upperTeeth.position.set(mo.x, mo.y + 0.004, mo.z - 0.04);
  const lowerTeeth = new THREE.Mesh(new THREE.BoxGeometry(mo.w * 0.56, 0.03, 0.03), teethMat);
  lowerTeeth.position.set(mo.x, mo.y - 0.03, mo.z - 0.05);
  lowerTeeth.userData.rest = lowerTeeth.position.clone();

  const head = new THREE.Group();
  head.add(faceMesh, shellMesh, cavity, ...mouthPieces);
  if (hairLayers) head.add(hairLayers);
  // simple ears only when no side photo shows the real ones
  if (!hasSides) {
    const earMat = new THREE.MeshStandardMaterial({ color: skin.clone().multiplyScalar(0.93), roughness: 0.85 });
    [234, 454].forEach((idx, k) => {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), earMat);
      ear.scale.set(0.045, 0.13, 0.085);
      ear.position.set(spec.pos[idx * 3] + (k ? -0.01 : 0.01), spec.pos[idx * 3 + 1] + 0.02, spec.pos[idx * 3 + 2] - 0.2);
      ear.rotation.y = k ? -0.35 : 0.35;
      head.add(ear);
    });
  }
  // drawn teeth only when the photo's mouth was closed (otherwise the real teeth show)
  if (!spec.mouthOpenInPhoto) head.add(upperTeeth, lowerTeeth);
  head.position.y = 0.04;
  group.add(torso, neck, head);
  return { group, head, faceMesh, shellMesh, plainMat, ringSize: shell.ringSize, lowerTeeth, mouthPieces, available };
}

/* -------------------------------- animation -------------------------------- */
const hinge = new THREE.Vector3();
const tmp = new THREE.Vector3();

function pose(spec, parts, mouth, blink) {
  const attr = parts.faceMesh.geometry.attributes.position;
  const arr = attr.array, rest = spec.pos;
  const theta = mouth * 0.26;
  hinge.set(0, spec.mouth.y + 0.17, spec.mouth.z - 0.42);
  const cos = Math.cos, sin = Math.sin;
  for (let i = 0; i < spec.n; i++) {
    let x = rest[i * 3], y = rest[i * 3 + 1], zz = rest[i * 3 + 2];
    const w = spec.jaw[i];
    if (w !== 0 && theta > 0) {
      const a = theta * w, dy = y - hinge.y, dz = zz - hinge.z;
      y = hinge.y + dy * cos(a) - dz * sin(a);
      zz = hinge.z + dy * sin(a) + dz * cos(a);
    }
    arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = zz;
  }
  if (blink > 0) {
    for (const eye of spec.eyes) {
      for (const i of eye.upper) {
        arr[i * 3 + 1] += (eye.lowerY - rest[i * 3 + 1]) * 0.92 * blink;
        arr[i * 3 + 2] += (eye.lowerZ - rest[i * 3 + 2]) * 0.6 * blink;
      }
    }
  }
  attr.needsUpdate = true;
  parts.faceMesh.geometry.computeVertexNormals();
  // keep the skull's first ring glued to the (moving) face outline
  const shellAttr = parts.shellMesh.geometry.attributes.position;
  FACE_OVAL.forEach((idx, k) => {
    shellAttr.array[k * 3] = arr[idx * 3];
    shellAttr.array[k * 3 + 1] = arr[idx * 3 + 1];
    shellAttr.array[k * 3 + 2] = arr[idx * 3 + 2];
  });
  shellAttr.needsUpdate = true;
  // the photo's mouth interior: upper half fixed, lower half follows the jaw
  for (const piece of parts.mouthPieces) {
    if (!piece.userData.lower) continue;
    const pa = piece.geometry.attributes.position, r0 = piece.userData.rest;
    for (let k = 0; k < r0.length; k += 3) {
      const dy = r0[k + 1] - hinge.y, dz = r0[k + 2] - hinge.z;
      pa.array[k + 1] = hinge.y + dy * cos(theta) - dz * sin(theta);
      pa.array[k + 2] = hinge.z + dy * sin(theta) + dz * cos(theta);
    }
    pa.needsUpdate = true;
  }
  // lower teeth ride with the jaw
  const r = parts.lowerTeeth.userData.rest;
  tmp.set(r.x, r.y - hinge.y, r.z - hinge.z);
  parts.lowerTeeth.position.set(r.x, hinge.y + tmp.y * cos(theta) - tmp.z * sin(theta), hinge.z + tmp.y * sin(theta) + tmp.z * cos(theta));
  parts.lowerTeeth.rotation.x = theta;
}

// For export: glTF can't carry the blending shader, so bake each blended mesh
// to vertex colours sampled from the atlas (the face keeps its front photo texture).
function bakeForExport(parts, atlas) {
  // strand-cut hair layers rely on alpha testing, which glTF viewers don't apply the same way
  const hair = parts.head.getObjectByName('hair');
  if (hair) hair.removeFromParent();
  const ctx = atlas.getContext('2d'), W = atlas.width, H = atlas.height;
  const data = ctx.getImageData(0, 0, W, H).data;
  const at = (u, v) => {
    const x = Math.min(W - 1, Math.max(0, Math.round(u * W))), y = Math.min(H - 1, Math.max(0, Math.round((1 - v) * H)));
    const i = (y * W + x) * 4;
    return new THREE.Color().setRGB(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, THREE.SRGBColorSpace);
  };
  const g = parts.shellMesh.geometry, n = g.attributes.position.count, out = new Float32Array(n * 3);
  const keys = ['uvF', 'uvR', 'uvL', 'uvB'];
  for (let i = 0; i < n; i++) {
    const w = [0, 1, 2, 3].map((k) => g.attributes.vw.array[i * 4 + k]), sum = w.reduce((a, b) => a + b, 0);
    const base = new THREE.Color(g.attributes.vcol.array[i * 3], g.attributes.vcol.array[i * 3 + 1], g.attributes.vcol.array[i * 3 + 2]);
    if (sum > 0) {
      const c = new THREE.Color(0, 0, 0);
      keys.forEach((k, j) => { if (w[j]) c.add(at(g.attributes[k].array[i * 2], g.attributes[k].array[i * 2 + 1]).multiplyScalar(w[j] / sum)); });
      base.lerp(c, Math.min(1, sum * 3));
    }
    out.set([base.r, base.g, base.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(out, 3));
  parts.shellMesh.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  parts.faceMesh.material = parts.plainMat;
  [parts.shellMesh.geometry, parts.faceMesh.geometry].forEach((geo) => keys.concat(['vw', 'vcol']).forEach((k) => geo.deleteAttribute(k)));
}

/* --------------------------------- public --------------------------------- */

export function has3D(face) {
  return !!(face && face.kind === 'mesh' && face.depth && face.depth.length === face.points.length);
}

export function supported() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch (e) { return false; }
}

// Paints everything outside the face outline with skin colour, so the edges of
// the 3D face never pick up background, ears or collar.
function cleanFront(face, img) {
  const FM = mesh(), p = face.points, SIZE = FM.SIZE;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const sample = sampler(img);
  const skin = sample(p[205][0] - 6, p[205][1] - 6, p[205][0] + 6, p[205][1] + 6);
  const cx = (p[454][0] + p[234][0]) / 2, cy = (p[10][1] + p[152][1]) / 2;
  const scale = img.width / SIZE;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, c.width, c.height);
  FACE_OVAL.forEach((i, k) => {
    const x = (p[i][0] + (cx - p[i][0]) * 0.03) * scale, y = (p[i][1] + (cy - p[i][1]) * 0.03) * scale;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.clip('evenodd');
  ctx.fillStyle = '#' + skin.getHexString(THREE.SRGBColorSpace);
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.restore();
  return c;
}

async function texturize(face) {
  const img = await loadImage(face.photo);
  const atlas = document.createElement('canvas');
  atlas.width = TILE * ATLAS_COLS; atlas.height = TILE * ATLAS_ROWS;
  const ctx = atlas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, atlas.width, atlas.height);
  const put = (tile, src) => ctx.drawImage(src, (tile % ATLAS_COLS) * TILE, Math.floor(tile / ATLAS_COLS) * TILE, TILE, TILE);
  put(TILES.faceClean, cleanFront(face, img));
  put(TILES.front, img);
  const views = face.views || {};
  for (const k of ['right', 'left', 'back']) {
    if (views[k] && views[k].photo) put(TILES[k], await loadImage(views[k].photo));
  }
  const texture = new THREE.CanvasTexture(atlas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return { img, texture, atlas };
}

/*
 * Renders the 3D avatar in place of `canvas` (a fresh WebGL canvas takes its
 * place and id; stop() puts the original back). getLevel() drives the mouth.
 * opts.interactive lets the viewer drag to turn the head.
 */
export function attach(canvas, face, getLevel, opts = {}) {
  let stopped = false, raf = 0, renderer = null, ro = null;
  const gl = document.createElement('canvas');
  gl.className = canvas.className;
  gl.style.cssText = canvas.style.cssText;
  gl.setAttribute('aria-label', '3D avatar');
  const id = canvas.id;
  canvas.style.display = 'none';
  canvas.id = id + '-2d';
  gl.id = id;
  canvas.after(gl);

  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    if (ro) ro.disconnect();
    if (renderer) { renderer.dispose(); renderer.forceContextLoss(); }
    gl.remove();
    canvas.id = id;
    canvas.style.display = '';
  };

  texturize(face).then(({ img, texture }) => {
    if (stopped) return;
    const spec = buildSpec(face, img);
    const parts = buildHead(spec, texture, face);

    renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.add(parts.group);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    scene.add(new THREE.HemisphereLight(0xfff6ee, 0x5d5a66, 1.4));
    // rim light from behind picks out the hair strands and the shoulders' edge
    const rim = new THREE.DirectionalLight(0xdfe8ff, 1.3);
    rim.position.set(-0.6, 1.4, -2.4);
    scene.add(rim);
    const key = new THREE.DirectionalLight(0xfff1e4, 1.6);
    key.position.set(0.8, 1.1, 2.2);
    const fill = new THREE.DirectionalLight(0xffffff, 0.9);
    fill.position.set(-1.2, 0.8, -2.0);
    scene.add(key, fill);

    const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 50);
    const frameY = opts.frame === 'bust' ? -0.32 : -0.08;
    const viewH = opts.frame === 'bust' ? 2.6 : 2.05;
    camera.position.set(0, frameY + 0.05, (viewH / 2) / Math.tan(THREE.MathUtils.degToRad(11)));
    camera.lookAt(0, frameY, 0);

    const resize = () => {
      const w = gl.clientWidth || 300, h = gl.clientHeight || 300;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    ro = new ResizeObserver(resize);
    ro.observe(gl);
    resize();

    // how far the head may turn depends on which sides were actually scanned
    const sides = parts.available.includes('right') && parts.available.includes('left');
    const full = sides && parts.available.includes('back');
    const limit = full ? Infinity : sides ? 1.3 : 0.45;

    let dragYaw = 0, dragPitch = 0, dragging = false, lastX = 0, lastY = 0;
    if (opts.interactive) {
      gl.style.cursor = 'grab';
      gl.style.touchAction = 'none';
      gl.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; gl.setPointerCapture(e.pointerId); gl.style.cursor = 'grabbing'; });
      gl.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        dragYaw = Math.max(-limit, Math.min(limit, dragYaw + (e.clientX - lastX) * 0.01));
        dragPitch = Math.max(-0.4, Math.min(0.4, dragPitch + (e.clientY - lastY) * 0.008));
        lastX = e.clientX; lastY = e.clientY;
      });
      const up = () => { dragging = false; gl.style.cursor = 'grab'; };
      gl.addEventListener('pointerup', up);
      gl.addEventListener('pointercancel', up);
    }

    let mouth = 0, blinkAt = performance.now() + 1800;
    const frame = (now) => {
      if (stopped) return;
      const level = getLevel ? getLevel() : 0;
      mouth += (Math.min(1, level) - mouth) * 0.45;
      let blink = 0;
      if (now > blinkAt) {
        const t = (now - blinkAt) / 170;
        blink = t < 1 ? Math.sin(t * Math.PI) : 0;
        if (t >= 1) blinkAt = now + 2400 + Math.random() * 3200;
      }
      pose(spec, parts, mouth, blink);
      // after a drag the head eases back to facing the viewer (unless fully scanned)
      if (!dragging) {
        if (full) dragYaw = Math.atan2(Math.sin(dragYaw), Math.cos(dragYaw)) * 0.97;
        else dragYaw *= 0.96;
        dragPitch *= 0.96;
      }
      const s = now / 1000;
      // dragging turns the whole bust like a turntable; the head adds a small idle sway
      parts.group.rotation.y = dragYaw + (opts.yaw || 0);
      parts.head.rotation.y = Math.sin(s * 0.45) * 0.14;
      parts.head.rotation.x = Math.sin(s * 0.37) * 0.035 - mouth * 0.04 + dragPitch;
      parts.head.rotation.z = Math.sin(s * 0.29) * 0.025;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    if (opts.onReady) opts.onReady({ vertices: spec.n, triangles: spec.tris.length, views: parts.available, measured: spec.measured });
  }).catch((err) => { if (opts.onError) opts.onError(err); stop(); });

  return stop;
}

/* Exports the avatar as a binary glTF (.glb) blob. */
export async function exportGLB(face) {
  const { img, texture, atlas } = await texturize(face);
  const spec = buildSpec(face, img);
  const parts = buildHead(spec, texture, face);
  bakeForExport(parts, atlas);
  const scene = new THREE.Scene();
  scene.add(parts.group);
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
  return new Blob([glb], { type: 'model/gltf-binary' });
}
