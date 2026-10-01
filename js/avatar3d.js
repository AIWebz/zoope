/*
 * 3D avatar generation, all on-device.
 *
 * Builds a real 3D head from a face scan: the 478 MediaPipe landmarks (with
 * depth) become a textured face surface, which is closed into a full head by a
 * skull shell stitched to the face outline, then given a neck and shoulders.
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

/* ------------------------------ model building ------------------------------ */
// Turns a scanned face into a description of the head: positions, uvs, triangles,
// animation weights and sampled colours. Cached per face.
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
    uv[i * 2] = p[i][0] / SIZE;
    uv[i * 2 + 1] = 1 - p[i][1] / SIZE;
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
    if (!insidePolygon(gx, gy, lipPoly)) tris.push(t);
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

  // colours sampled from the photo
  const sample = sampler(img);
  const skin = sample(p[205][0] - 6, p[205][1] - 6, p[205][0] + 6, p[205][1] + 6)
    .lerp(sample(p[425][0] - 6, p[425][1] - 6, p[425][0] + 6, p[425][1] + 6), 0.5);
  const dist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
  // hair is usually the darker part of the band above the forehead
  const hair = sample(top[0] - faceW * 0.2, top[1] - faceH * 0.2, top[0] + faceW * 0.2, top[1] - faceH * 0.06, 0.3);
  const bg = sample(0, 0, SIZE * 0.08, SIZE * 0.3).lerp(sample(SIZE * 0.92, 0, SIZE, SIZE * 0.3), 0.5);
  // hair that matches the skin or the background means very short hair: use a dark crop
  const shortHair = dist(hair, skin) < 0.12 || dist(hair, bg) < 0.1;
  const bald = false;
  // clothing: both shoulders, just below the jaw line, kept inside the photo
  const shY = Math.min(SIZE * 0.93, chin[1] + faceH * 0.42);
  const shirt = sample(cx - faceW * 0.95, shY - 8, cx - faceW * 0.55, shY + 8)
    .lerp(sample(cx + faceW * 0.55, shY - 8, cx + faceW * 0.95, shY + 8), 0.5);
  const ovalColors = FACE_OVAL.map((i) => {
    // step slightly inside the outline so the colour is face/hair, not background
    const x = p[i][0] + (cx - p[i][0]) * 0.06, y = p[i][1] + (cy - p[i][1]) * 0.06;
    return sample(x - 3, y - 3, x + 3, y + 3);
  });

  const spec = {
    n, pos, uv, tris, mouthTris, toHead, SIZE, mouthOpenInPhoto, jaw, S,
    mouth: { x: (pos[78 * 3] + pos[308 * 3]) / 2, y: (pos[13 * 3 + 1] + pos[14 * 3 + 1]) / 2, z: Math.min(pos[13 * 3 + 2], pos[14 * 3 + 2]), w: Math.abs(pos[308 * 3] - pos[78 * 3]) },
    eyes: FM.EYES.map((e) => ({
      upper: e.upper,
      lowerY: e.lower.reduce((s, i) => s + pos[i * 3 + 1], 0) / e.lower.length,
      lowerZ: e.lower.reduce((s, i) => s + pos[i * 3 + 2], 0) / e.lower.length
    })),
    chinY: pos[152 * 3 + 1],
    colors: { skin, hair: shortHair ? skin.clone().lerp(new THREE.Color(0.09, 0.07, 0.06), 0.72) : hair, shirt, oval: ovalColors, bald }
  };
  specCache.set(face, spec);
  return spec;
}

// skull shell: rings sweep from the face outline over and behind the head
function buildShell(spec) {
  const ring0 = FACE_OVAL.map((i) => new THREE.Vector3(spec.pos[i * 3], spec.pos[i * 3 + 1], spec.pos[i * 3 + 2]));
  const minX = Math.min(...ring0.map((v) => v.x)), maxX = Math.max(...ring0.map((v) => v.x));
  const meanZ = ring0.reduce((s, v) => s + v.z, 0) / ring0.length;
  const C = new THREE.Vector3((minX + maxX) / 2, 0.12, meanZ - 0.3);
  const R = new THREE.Vector3((maxX - minX) / 2 * 1.12, 0.67, 0.64);
  const back = new THREE.Vector3(0, 0.3, -1).normalize();
  const m = ring0.length;
  const positions = [], colors = [], index = [];
  const hair = spec.colors.hair, skinDark = spec.colors.skin.clone().multiplyScalar(0.82);

  for (let k = 0; k <= SHELL_RINGS; k++) {
    const t = k / SHELL_RINGS;
    for (let i = 0; i < m; i++) {
      let v;
      if (k === 0) v = ring0[i];
      else {
        const rel = ring0[i].clone().sub(C).divide(R);
        const f = rel.length(); // how far this outline point sits from the ellipsoid (1 = on it)
        const d = rel.normalize();
        const s = slerp(d, back, t);
        const ease = Math.min(1, t * 2.5), smooth = ease * ease * (3 - 2 * ease);
        const radial = f + (1 - f) * smooth; // start on the outline, settle onto the skull
        // a little extra volume for hair on the crown
        const puff = 1 + 0.08 * Math.max(0, s.y) * Math.sin(Math.PI * Math.min(1, t * 1.4));
        v = C.clone().add(s.clone().multiply(R).multiplyScalar(puff * radial));
        v.x = C.x + (v.x - C.x) * (1 + 0.1 * Math.max(0, s.y)); // fuller temples and crown
      }
      positions.push(v.x, v.y, v.z);
      const dir = ring0[i].clone().sub(C).normalize();
      const target = dir.y > -0.25 ? hair : skinDark;
      // the top of the face outline is the hairline, so hair starts right away there
      const speed = dir.y > 0.35 ? 9 : 2.4;
      const c = spec.colors.oval[i].clone().lerp(target, Math.min(1, t * speed));
      colors.push(c.r, c.g, c.b);
    }
  }
  for (let k = 0; k < SHELL_RINGS; k++) {
    for (let i = 0; i < m; i++) {
      const a = k * m + i, b = k * m + (i + 1) % m, c = (k + 1) * m + i, d = (k + 1) * m + (i + 1) % m;
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return { geo, center: C, radii: R };
}

function buildHead(spec, texture) {
  const group = new THREE.Group();
  group.name = 'zoope-avatar';

  // face surface
  const faceGeo = new THREE.BufferGeometry();
  faceGeo.setAttribute('position', new THREE.BufferAttribute(spec.pos.slice(), 3));
  faceGeo.setAttribute('uv', new THREE.BufferAttribute(spec.uv, 2));
  faceGeo.setIndex(spec.tris.flat());
  faceGeo.computeVertexNormals();
  const faceMat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.78, metalness: 0, side: THREE.DoubleSide });
  const faceMesh = new THREE.Mesh(faceGeo, faceMat);
  faceMesh.name = 'face';

  // head shell, neck and shoulders
  const shell = buildShell(spec);
  const shellMesh = new THREE.Mesh(shell.geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
  shellMesh.name = 'head';

  const skin = spec.colors.skin;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 0.62, 32, 1, true),
    new THREE.MeshStandardMaterial({ color: skin.clone().multiplyScalar(0.86), roughness: 0.85, side: THREE.DoubleSide }));
  neck.position.set(shell.center.x, spec.chinY - 0.12, shell.center.z + 0.06);
  neck.name = 'neck';

  const torso = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: spec.colors.shirt, roughness: 0.95 }));
  torso.scale.set(1.3, 0.52, 0.55);
  torso.position.set(shell.center.x, spec.chinY - 0.78, shell.center.z + 0.02);
  torso.name = 'shoulders';

  // the photo's own mouth interior, split so the jaw can open it
  const mouthPieces = [false, true].map((lower) => {
    const list = spec.mouthTris.filter((m) => m.lower === lower);
    if (!list.length) return null;
    const verts = [], uvs = [];
    list.forEach(({ quad }) => [0, 1, 2, 0, 2, 3].forEach((k) => {
      const q = quad[k], h = spec.toHead(q[0], q[1]);
      verts.push(h[0], h[1], h[2]);
      uvs.push(q[0] / spec.SIZE, 1 - q[1] / spec.SIZE);
    }));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.computeVertexNormals();
    const meshPiece = new THREE.Mesh(g, faceMat);
    meshPiece.userData = { lower, rest: Float32Array.from(verts) };
    return meshPiece;
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

  // ears
  const earMat = new THREE.MeshStandardMaterial({ color: skin.clone().multiplyScalar(0.93), roughness: 0.85 });
  const ears = [234, 454].map((idx, k) => {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), earMat);
    ear.scale.set(0.045, 0.13, 0.085);
    const sx = spec.pos[idx * 3], sy = spec.pos[idx * 3 + 1], sz = spec.pos[idx * 3 + 2];
    ear.position.set(sx + (k ? -0.01 : 0.01), sy + 0.02, sz - 0.2);
    ear.rotation.y = k ? -0.35 : 0.35;
    return ear;
  });

  const head = new THREE.Group();
  head.add(faceMesh, shellMesh, cavity, ...ears, ...mouthPieces);
  // drawn teeth only when the photo's mouth was closed (otherwise the real teeth show)
  if (!spec.mouthOpenInPhoto) head.add(upperTeeth, lowerTeeth);
  head.position.y = 0.04;
  group.add(torso, neck, head);
  return { group, head, faceMesh, shellMesh, lowerTeeth, mouthPieces };
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

// Paints everything outside the face outline with nearby skin and hair colours,
// so the edges of the 3D face never pick up background, ears or collar.
function cleanTexture(face, img) {
  const FM = mesh(), p = face.points, SIZE = FM.SIZE;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const sample = sampler(img);
  const skin = sample(p[205][0] - 6, p[205][1] - 6, p[205][0] + 6, p[205][1] + 6);
  const css = (col) => '#' + col.getHexString(THREE.SRGBColorSpace);
  const cx = (p[454][0] + p[234][0]) / 2, cy = (p[10][1] + p[152][1]) / 2;
  const scale = img.width / SIZE;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, c.width, c.height);
  FACE_OVAL.forEach((i, k) => {
    // pull the outline in a touch so the boundary texels are certainly face
    const x = (p[i][0] + (cx - p[i][0]) * 0.03) * scale, y = (p[i][1] + (cy - p[i][1]) * 0.03) * scale;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.clip('evenodd');
  ctx.fillStyle = css(skin);
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.restore();
  return c;
}

async function texturize(face) {
  const img = await loadImage(face.photo);
  const texture = new THREE.Texture(cleanTexture(face, img));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return { img, texture };
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
    const parts = buildHead(spec, texture);

    renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.add(parts.group);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6b78, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(0.8, 1.1, 2.2);
    const rim = new THREE.DirectionalLight(0xbcd2ff, 0.9);
    rim.position.set(-1.6, 0.6, -1.4);
    scene.add(key, rim);

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

    // drag to turn the head
    let dragYaw = 0, dragPitch = 0, dragging = false, lastX = 0, lastY = 0;
    if (opts.interactive) {
      gl.style.cursor = 'grab';
      gl.style.touchAction = 'none';
      gl.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; gl.setPointerCapture(e.pointerId); gl.style.cursor = 'grabbing'; });
      gl.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        dragYaw = Math.max(-0.45, Math.min(0.45, dragYaw + (e.clientX - lastX) * 0.008));
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
      if (!dragging) { dragYaw *= 0.96; dragPitch *= 0.96; }
      const s = now / 1000;
      parts.head.rotation.y = Math.sin(s * 0.45) * 0.14 + dragYaw + (opts.yaw || 0);
      parts.head.rotation.x = Math.sin(s * 0.37) * 0.035 - mouth * 0.04 + dragPitch;
      parts.head.rotation.z = Math.sin(s * 0.29) * 0.025;
      parts.group.rotation.y = dragYaw * 0.35;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    if (opts.onReady) opts.onReady({ vertices: spec.n, triangles: spec.tris.length });
  }).catch((err) => { if (opts.onError) opts.onError(err); stop(); });

  return stop;
}

/* Exports the avatar as a binary glTF (.glb) blob. */
export async function exportGLB(face) {
  const { img, texture } = await texturize(face);
  const spec = buildSpec(face, img);
  const parts = buildHead(spec, texture);
  const scene = new THREE.Scene();
  scene.add(parts.group);
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
  return new Blob([glb], { type: 'model/gltf-binary' });
}

/* Counts for the UI. */
export async function stats(face) {
  const { img } = await texturize(face);
  const spec = buildSpec(face, img);
  return { vertices: spec.n + FACE_OVAL.length * (SHELL_RINGS + 1), triangles: spec.tris.length + FACE_OVAL.length * SHELL_RINGS * 2 };
}
