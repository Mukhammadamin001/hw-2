#!/usr/bin/env node
/**
 * Bakes a 3D head scan into a compact particle cloud used by js/particles.js.
 *
 * Source model: "Lee Perry-Smith" head scan by Infinite-Realities
 * (https://www.ir-ltd.net/), licensed CC BY 3.0, as shipped in the three.js examples.
 *
 * Usage:
 *   node tools/bake-head.mjs [path/to/LeePerrySmith.glb] [pointCount]
 *
 * If no path is given the model is downloaded from the three.js GitHub repository.
 * Output: js/head-data.js  (positions as Int16 + normals as Int8, base64 encoded)
 *
 * No npm dependencies — it parses the GLB container by hand.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODEL_URL =
  'https://raw.githubusercontent.com/mrdoob/three.js/r170/examples/models/gltf/LeePerrySmith/LeePerrySmith.glb';
const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, '..', 'js', 'head-data.js');

const inputPath = process.argv[2];
const COUNT = Number(process.argv[3] || 64000);
const SCALE = 4.5; // positions are stored as int16 in [-SCALE, SCALE]

async function loadGlb() {
  if (inputPath) return new Uint8Array(await readFile(inputPath));
  console.log('Downloading', MODEL_URL);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function parseGlb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB file');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  const binOffset = 20 + jsonLen + 8;
  const bin = bytes.subarray(binOffset);

  const read = (accessorIndex) => {
    const acc = json.accessors[accessorIndex];
    const view = json.bufferViews[acc.bufferView];
    const start = (view.byteOffset || 0) + (acc.byteOffset || 0);
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
    const n = acc.count * comps;
    const slice = bin.slice(start, start + view.byteLength);
    if (acc.componentType === 5126) return new Float32Array(slice.buffer, 0, n);
    if (acc.componentType === 5123) return new Uint16Array(slice.buffer, 0, n);
    if (acc.componentType === 5125) return new Uint32Array(slice.buffer, 0, n);
    throw new Error('Unsupported component type ' + acc.componentType);
  };

  const prim = json.meshes[0].primitives[0];
  return {
    position: read(prim.attributes.POSITION),
    normal: read(prim.attributes.NORMAL),
    index: read(prim.indices),
  };
}

// Small deterministic PRNG so the bake is reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Voxelises the whole mesh so we can tell outer skin from hidden interior surfaces
 * (the scan has a closed mouth cavity inside the jaw that would otherwise shine
 * through the additive-blended particles).
 */
function buildOccupancy(P, I, cell = 0.05) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], P[i + k]);
      max[k] = Math.max(max[k], P[i + k]);
    }
  }
  min = min.map((v) => v - cell * 2);
  const dim = max.map((v, k) => Math.ceil((v - min[k]) / cell) + 3);
  const grid = new Uint8Array(dim[0] * dim[1] * dim[2]);
  const idx = (x, y, z) => {
    const i = Math.floor((x - min[0]) / cell), j = Math.floor((y - min[1]) / cell), k = Math.floor((z - min[2]) / cell);
    if (i < 0 || j < 0 || k < 0 || i >= dim[0] || j >= dim[1] || k >= dim[2]) return -1;
    return i + dim[0] * (j + dim[1] * k);
  };
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const e = Math.max(
      Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]),
      Math.hypot(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]),
      Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2])
    );
    const steps = Math.max(1, Math.ceil(e / (cell * 0.5)));
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        const u = i / steps, v = j / steps, w = 1 - u - v;
        const g = idx(
          P[a] * w + P[b] * u + P[c] * v,
          P[a + 1] * w + P[b + 1] * u + P[c + 1] * v,
          P[a + 2] * w + P[b + 2] * u + P[c + 2] * v
        );
        if (g >= 0) grid[g] = 1;
      }
    }
  }
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  // A point is "enclosed" when marching along every axis eventually hits the mesh again.
  return function isEnclosed(x, y, z, skip = 0.12) {
    for (const d of DIRS) {
      let hit = false;
      for (let s = skip; ; s += cell * 0.6) {
        const g = idx(x + d[0] * s, y + d[1] * s, z + d[2] * s);
        if (g < 0) break; // left the grid → this direction escapes
        if (grid[g]) { hit = true; break; }
      }
      if (!hit) return false;
    }
    return true;
  };
}

function bake({ position: P, normal: N, index: I }) {
  const rand = mulberry32(1337);
  const isEnclosed = buildOccupancy(P, I);

  // Keep the head + neck, drop the shoulders (and the collar where they meet the neck).
  const keep = (a, b, c) => {
    for (const v of [a, b, c]) {
      const x = P[v * 3], y = P[v * 3 + 1], ny = N[v * 3 + 1];
      if (y < -2.9) return false;
      if (y < -0.4 && Math.abs(x) > 1.75) return false;
      if (y < -0.9 && ny > 0.35) return false; // upward-facing shoulder tops
    }
    return true;
  };

  const tris = [];
  const cdf = [];
  let total = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    if (!keep(a, b, c)) continue;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    let area = 0.5 * Math.hypot(cx, cy, cz);
    // Slightly densify the face so its features read well as particles.
    const nz = (N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2]) / 3;
    const ty = (ay + P[b * 3 + 1] + P[c * 3 + 1]) / 3;
    if (nz > 0.2 && ty > 0.0) area *= 1.35;
    total += area;
    tris.push(a, b, c);
    cdf.push(total);
  }

  const pos = new Int16Array(COUNT * 3);
  const nrm = new Int8Array(COUNT * 3);
  const q = (v) => Math.max(-32767, Math.min(32767, Math.round((v / SCALE) * 32767)));

  let rejected = 0;
  for (let i = 0; i < COUNT; i++) {
    // Pick a triangle weighted by area (binary search on the CDF).
    const r = rand() * total;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1; else hi = mid;
    }
    const a = tris[lo * 3], b = tris[lo * 3 + 1], c = tris[lo * 3 + 2];
    let u = rand(), v = rand();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    let nx = N[a * 3] * w + N[b * 3] * u + N[c * 3] * v;
    let ny = N[a * 3 + 1] * w + N[b * 3 + 1] * u + N[c * 3 + 1] * v;
    let nz = N[a * 3 + 2] * w + N[b * 3 + 2] * u + N[c * 3 + 2] * v;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const px = P[a * 3] * w + P[b * 3] * u + P[c * 3] * v;
    const py = P[a * 3 + 1] * w + P[b * 3 + 1] * u + P[c * 3 + 1] * v;
    const pz = P[a * 3 + 2] * w + P[b * 3 + 2] * u + P[c * 3 + 2] * v;
    if (isEnclosed(px, py, pz)) { rejected++; i--; continue; }
    pos[i * 3] = q(px);
    pos[i * 3 + 1] = q(py);
    pos[i * 3 + 2] = q(pz);
    nrm[i * 3] = Math.round(nx * 127);
    nrm[i * 3 + 1] = Math.round(ny * 127);
    nrm[i * 3 + 2] = Math.round(nz * 127);
  }

  console.log(`Rejected ${rejected} samples on hidden interior surfaces`);
  const bytes = new Uint8Array(pos.byteLength + nrm.byteLength);
  bytes.set(new Uint8Array(pos.buffer), 0);
  bytes.set(new Uint8Array(nrm.buffer), pos.byteLength);
  return Buffer.from(bytes).toString('base64');
}

const mesh = parseGlb(await loadGlb());
const b64 = bake(mesh);
const banner =
  '/* Generated by tools/bake-head.mjs — do not edit by hand.\n' +
  ' * Particle cloud sampled from the "Lee Perry-Smith" head scan by Infinite-Realities, CC BY 3.0.\n' +
  ' * Layout: Int16 positions (x,y,z) * count, scaled by `scale`, then Int8 normals (x,y,z) * count. */\n';
await writeFile(
  outFile,
  `${banner}window.HEAD_POINTS = { count: ${COUNT}, scale: ${SCALE}, data: "${b64}" };\n`
);
console.log(`Wrote ${COUNT} points → ${path.relative(process.cwd(), outFile)} (${(b64.length / 1024).toFixed(0)} KB)`);
