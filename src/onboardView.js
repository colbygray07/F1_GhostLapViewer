// Onboard view, styled like a TV broadcast.
// The circuit is built in 3D from the fastest car's real path. The car you're
// riding with is solid; the other two laps are see-through "ghosts".

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { formatLapTime, formatGap, formatSector } from './format.js';

const HALF = 6.5; // half the road width, in metres
const STEP = 3; // metres between track samples
const KERB_CURVATURE = 1 / 110; // corners tighter than a 110 m radius get kerbs
const GRAVEL_CURVATURE = 1 / 75; // ...and tighter than 75 m get a gravel trap outside
const SUN = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(54), THREE.MathUtils.degToRad(150));

export const CAMERAS = [
  { id: 'tcam', label: 'T-cam', pos: [0, 1.38, 1.0], pitch: -0.17, fov: 60 },
  { id: 'cockpit', label: 'Cockpit', pos: [0, 0.9, 0.18], pitch: -0.035, fov: 64 },
  { id: 'chase', label: 'Chase', pos: [0, 2.5, 8.2], pitch: -0.13, fov: 54, orbit: true },
];

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- Helpers ----------

let maxAnisotropy = 8;

function canvasTexture(width, height, paint, { repeat = false, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  paint(c.getContext('2d'), width, height);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Fill a canvas pixel by pixel: fn(u, v) returns [r, g, b, a?].
function pixels(ctx, w, h, fn) {
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = fn(x / w, y / h, x, y);
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function angleLerp(from, to, k) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * k;
}

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    mats.forEach((m) => {
      if (m.map && !m.map.userData.shared) m.map.dispose();
      m.dispose();
    });
  });
}

// Smooth tube-like shape through a list of cross-sections {z, w, h, y}.
// Each cross-section is a rounded rectangle, so this makes nose cones,
// sidepods and engine covers that flow into each other. UVs run along the
// car (u) and around it (v: 0 = right side, 0.25 = top, 0.5 = left, 0.75 = underneath)
// so a livery texture can be painted onto it.
function loft(sections, radial = 28, roundness = 3.4) {
  const pos = [];
  const uv = [];
  const idx = [];
  const ring = radial + 1; // the seam vertex is duplicated so the texture doesn't smear
  const z0 = sections[0].z;
  const z1 = sections[sections.length - 1].z;
  for (const s of sections) {
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      pos.push(
        (s.w / 2) * Math.sign(c) * Math.abs(c) ** (2 / roundness),
        s.y + (s.h / 2) * Math.sign(sn) * Math.abs(sn) ** (2 / roundness),
        s.z
      );
      uv.push((s.z - z0) / (z1 - z0), k / radial);
    }
  }
  for (let i = 0; i < sections.length - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const a = i * ring + k;
      const b = a + 1;
      idx.push(a, b, a + ring, b, b + ring, a + ring);
    }
  }
  const capAt = (i, flip) => {
    const s = sections[i];
    pos.push(0, s.y, s.z);
    uv.push((s.z - z0) / (z1 - z0), 0.25);
    const c = pos.length / 3 - 1;
    for (let k = 0; k < radial; k++) {
      const a = i * ring + k;
      idx.push(...(flip ? [c, a + 1, a] : [c, a, a + 1]));
    }
  };
  capAt(0, true);
  capAt(sections.length - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Average the normals across the seam so there's no visible line.
  const nrm = g.attributes.normal;
  for (let i = 0; i < sections.length; i++) {
    const a = i * ring;
    const b = a + radial;
    const x = (nrm.getX(a) + nrm.getX(b)) / 2, y = (nrm.getY(a) + nrm.getY(b)) / 2, z = (nrm.getZ(a) + nrm.getZ(b)) / 2;
    nrm.setXYZ(a, x, y, z);
    nrm.setXYZ(b, x, y, z);
  }
  return g;
}

function rod(a, b, radius, material) {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const dir = vb.clone().sub(va);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, dir.length(), 6), material);
  mesh.position.copy(va).add(vb).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

// Flat quads collected into one mesh. Used for every surface laid along the track.
class Strips {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.col = [];
  }
  quad(a, b, c, d, uvs, colour) {
    // a-b is one long edge and c-d the other, in track order. Flat quads are
    // wound so they face upwards, otherwise they'd be lit from underneath.
    const ux = b[0] - a[0], uz = b[2] - a[2];
    const vx = c[0] - a[0], vz = c[2] - a[2];
    const up = uz * vx - ux * vz; // y component of (b - a) x (c - a)
    const order = up >= 0
      ? [[a, uvs[0]], [b, uvs[1]], [c, uvs[2]], [c, uvs[2]], [b, uvs[1]], [d, uvs[3]]]
      : [[a, uvs[0]], [c, uvs[2]], [b, uvs[1]], [c, uvs[2]], [d, uvs[3]], [b, uvs[1]]];
    for (const [p, t] of order) {
      this.pos.push(p[0], p[1], p[2]);
      this.uv.push(t[0], t[1]);
      if (colour) this.col.push(colour.r, colour.g, colour.b);
    }
  }
  mesh(material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.receiveShadow = true;
    return m;
  }
}

// Quick lookups for "is anything on the track near this point?"
class TrackGrid {
  constructor(samples, cell = 25) {
    this.cell = cell;
    this.map = new Map();
    for (const p of samples) {
      const key = `${Math.floor(p.x / cell)},${Math.floor(p.z / cell)}`;
      if (!this.map.has(key)) this.map.set(key, []);
      this.map.get(key).push(p);
    }
  }
  // True if no track centreline point is within r metres.
  clear(x, z, r) {
    const span = Math.ceil(r / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const r2 = r * r;
    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        const list = this.map.get(`${cx + i},${cz + j}`);
        if (list) for (const p of list) if ((p.x - x) ** 2 + (p.z - z) ** 2 < r2) return false;
      }
    }
    return true;
  }
}

// Closed loop of {x, z} points: smooth it, resample every STEP metres, and
// work out direction, sideways normal and curvature at each sample.
function prepareCentreline(points) {
  // The lap path is already smoothed in lapData, so only a light touch here;
  // more would pull the road away from where the cars actually drive.
  const n0 = points.length;
  const pts = points.map((_, i) => {
    let x = 0, z = 0;
    for (let k = -2; k <= 2; k++) {
      const p = points[(i + k + n0) % n0];
      x += p.x;
      z += p.z;
    }
    return { x: x / 5, z: z / 5 };
  });

  const loop = [...pts, pts[0]];
  const cum = [0];
  for (let i = 1; i < loop.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(loop[i].x - loop[i - 1].x, loop[i].z - loop[i - 1].z));
  }
  const length = cum[cum.length - 1];
  const out = [];
  let j = 0;
  for (let d = 0; d < length; d += STEP) {
    while (cum[j + 1] < d) j++;
    const k = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
    out.push({ x: loop[j].x + (loop[j + 1].x - loop[j].x) * k, z: loop[j].z + (loop[j + 1].z - loop[j].z) * k, d });
  }

  const n = out.length;
  out.forEach((p, i) => {
    const a = out[(i - 1 + n) % n];
    const b = out[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    p.tx = (b.x - a.x) / len;
    p.tz = (b.z - a.z) / len;
    p.nx = -p.tz; // sideways normal, pointing to the driver's right
    p.nz = p.tx;
  });
  out.forEach((p, i) => {
    const a = out[(i - 3 + n) % n];
    const b = out[(i + 3) % n];
    p.turn = Math.atan2(a.tx * b.tz - a.tz * b.tx, a.tx * b.tx + a.tz * b.tz) / (6 * STEP); // >0 is a right-hander
    p.curv = Math.abs(p.turn);
  });
  return { samples: out, length };
}

const at = (p, off, y) => [p.x + p.nx * off, y, p.z + p.nz * off];

// OpenF1 gives us where the car drove, not where the track edges are. F1 cars
// take corners outside-apex-outside: wide on entry, tight at the apex, wide on
// exit. So we work backwards: where the line bends more sharply than its
// surroundings (an apex), the car is on the inside; just before and after,
// it's on the outside. Shifting the road the other way recovers the track.
function deriveTrackCentre(lineSamples) {
  const n = lineSamples.length;
  const blur = (values, sigma) => {
    const radius = Math.ceil(sigma * 3);
    const w = Array.from({ length: radius * 2 + 1 }, (_, k) => Math.exp(-((k - radius) ** 2) / (2 * sigma * sigma)));
    return values.map((_, i) => {
      let sum = 0, ws = 0;
      for (let k = -radius; k <= radius; k++) {
        sum += values[(i + k + n) % n] * w[k + radius];
        ws += w[k + radius];
      }
      return sum / ws;
    });
  };
  const turn = lineSamples.map((p) => p.turn); // signed curvature, >0 = right-hander
  const local = blur(turn, 5); // ~15 m: the corner itself
  const wide = blur(turn, 55); // ~165 m: the corner and its approach and exit
  const room = HALF - 1.3; // how far from the centre a car's middle can be
  return lineSamples.map((p, i) => {
    // Positive = the car is towards the inside of the corner.
    const inside = room * Math.tanh((local[i] - wide[i]) / 0.0022);
    return { x: p.x - p.nx * inside, z: p.z - p.nz * inside };
  });
}

// ---------- Textures ----------

const textures = {};
function getTextures() {
  if (textures.road) return textures;
  const share = (t) => ((t.userData.shared = true), t);

  // Asphalt with a darker rubbered-in line down the middle.
  textures.road = share(canvasTexture(256, 256, (ctx, w, h) => {
    pixels(ctx, w, h, (u, v) => {
      const rubber = Math.exp(-(((v - 0.5) / 0.16) ** 2)) * 16 + Math.exp(-(((v - 0.5) / 0.05) ** 2)) * 6;
      const g = 82 + (Math.random() - 0.5) * 30 - rubber;
      return [g, g + 1, g + 4];
    });
  }, { repeat: true }));

  textures.grass = share(canvasTexture(512, 512, (ctx, w, h) => {
    pixels(ctx, w, h, (u, v) => {
      const stripe = Math.floor(v * 4) % 2 ? 1 : 0.88; // mowing stripes
      const n = 0.85 + Math.random() * 0.3;
      return [62 * stripe * n, 118 * stripe * n, 50 * stripe * n];
    });
  }, { repeat: true }));
  textures.grass.repeat.set(400, 400);

  textures.gravel = share(canvasTexture(256, 256, (ctx, w, h) => {
    pixels(ctx, w, h, () => {
      const n = Math.random();
      const g = n > 0.93 ? 0.7 : 0.9 + Math.random() * 0.2;
      return [205 * g, 184 * g, 148 * g];
    });
  }, { repeat: true }));

  textures.runoff = share(canvasTexture(128, 128, (ctx, w, h) => {
    pixels(ctx, w, h, () => {
      const g = 110 + (Math.random() - 0.5) * 26;
      return [g, g + 2, g + 5];
    });
  }, { repeat: true }));

  textures.boards = share(canvasTexture(2048, 128, (ctx, w, h) => {
    const panels = [
      { bg: '#15204f', fg: '#ffffff', text: 'GHOST LAP' },
      { bg: '#f4f4f4', fg: '#7c3aed', text: 'FASTEST LAP' },
      { bg: '#7c3aed', fg: '#ffffff', text: 'GHOST LAP' },
      { bg: '#0f1114', fg: '#ffd23f', text: 'SECTOR 1' },
      { bg: '#c8102e', fg: '#ffffff', text: 'GHOST LAP' },
      { bg: '#f4f4f4', fg: '#15204f', text: 'POLE POSITION' },
    ];
    const pw = w / panels.length;
    panels.forEach((p, i) => {
      ctx.fillStyle = p.bg;
      ctx.fillRect(i * pw, 0, pw, h);
      ctx.fillStyle = p.fg;
      ctx.font = 'italic 900 68px "Big Shoulders Display", "Arial Narrow", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.text, (i + 0.5) * pw, h / 2 + 4);
    });
  }, { repeat: true }));

  // Chain-link catch fence: transparent except for the wire.
  textures.fence = share(canvasTexture(128, 128, (ctx, w, h) => {
    ctx.strokeStyle = 'rgba(190, 196, 204, 0.9)';
    ctx.lineWidth = 2;
    for (let i = -w; i < w * 2; i += 16) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + h, h);
      ctx.moveTo(i, h);
      ctx.lineTo(i + h, 0);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(150, 156, 164, 1)';
    ctx.fillRect(0, 0, w, 4);
  }, { repeat: true }));

  textures.crowd = share(canvasTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = '#3a3f47';
    ctx.fillRect(0, 0, w, h);
    const shirts = ['#e8e8e8', '#ff8000', '#e10600', '#27f4d2', '#3671c6', '#ffd23f', '#9aa3ad', '#1e5bc6', '#c8102e', '#2b2b2b'];
    for (let row = 0; row < 32; row++) {
      const y = row * 8;
      ctx.fillStyle = '#5b616b';
      ctx.fillRect(0, y + 6, w, 2);
      for (let x = 0; x < w; x += 5) {
        if (Math.random() < 0.12) continue; // empty seat
        ctx.fillStyle = shirts[(Math.random() * shirts.length) | 0];
        ctx.fillRect(x + Math.random(), y + 3, 4, 3);
        ctx.fillStyle = ['#f1c9a5', '#c68e62', '#8d5a3b', '#e0ac82'][(Math.random() * 4) | 0];
        ctx.fillRect(x + 1, y + 1, 2, 2);
      }
    }
  }, { repeat: true }));

  textures.chequer = share(canvasTexture(256, 32, (ctx, w, h) => {
    const s = 16;
    for (let x = 0; x < w; x += s) {
      for (let y = 0; y < h; y += s) {
        ctx.fillStyle = (x / s + y / s) % 2 ? '#141414' : '#f4f4f4';
        ctx.fillRect(x, y, s, s);
      }
    }
  }));

  textures.pits = share(canvasTexture(2048, 256, (ctx, w, h) => {
    ctx.fillStyle = '#d7dbe0';
    ctx.fillRect(0, 0, w, h);
    // Upper floor glass
    ctx.fillStyle = '#29425e';
    ctx.fillRect(0, 18, w, 90);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    for (let x = 0; x < w; x += 64) ctx.fillRect(x, 18, 3, 90);
    ctx.fillStyle = '#7f8a96';
    ctx.fillRect(0, 108, w, 10);
    // Garage doors in team colours
    const teams = ['#3671c6', '#e8002d', '#27f4d2', '#ff8000', '#229971', '#ff87bc', '#6692ff', '#64c4ff', '#b6babd', '#52e252'];
    for (let i = 0; i < 20; i++) {
      const x = i * (w / 20);
      ctx.fillStyle = '#2a2e35';
      ctx.fillRect(x + 6, 130, w / 20 - 12, 120);
      ctx.fillStyle = teams[Math.floor(i / 2) % teams.length];
      ctx.fillRect(x + 6, 130, w / 20 - 12, 14);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      for (let y = 150; y < 250; y += 10) ctx.fillRect(x + 6, y, w / 20 - 12, 2);
    }
  }));

  textures.gantry = share(canvasTexture(1024, 128, (ctx, w, h) => {
    ctx.fillStyle = '#14181e';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#7c3aed';
    ctx.beginPath();
    ctx.moveTo(30, h - 22);
    ctx.lineTo(80, 22);
    ctx.lineTo(118, 22);
    ctx.lineTo(68, h - 22);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'italic 900 76px "Big Shoulders Display", "Arial Narrow", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('GHOST LAP', 140, h / 2 + 4);
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = '#2a0808';
      ctx.beginPath();
      ctx.arc(640 + i * 72, h / 2, 24, 0, Math.PI * 2);
      ctx.fill();
    }
  }));

  textures.blob = share(canvasTexture(128, 256, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.setTransform(1, 0, 0, h / w, 0, 0);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, w);
  }));
  return textures;
}

// ---------- The circuit ----------

function buildCircuit(samples) {
  const tex = getTextures();
  const group = new THREE.Group();
  const grid = new TrackGrid(samples);
  const n = samples.length;
  const obstacles = []; // footprints of buildings, so trees stay clear of them

  // The ground is split into many tiles and pushed back in the depth buffer,
  // so the road laid on top of it never flickers or disappears.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(14000, 14000, 80, 80),
    new THREE.MeshStandardMaterial({ map: tex.grass, roughness: 1, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  // Work out which corners get gravel on the outside, spreading each zone a
  // little before and after the corner like a real trap.
  const gravelSide = new Array(n).fill(0);
  samples.forEach((p, i) => {
    if (p.curv < GRAVEL_CURVATURE) return;
    const side = p.turn > 0 ? -1 : 1; // outside of the corner
    for (let k = -6; k <= 14; k++) gravelSide[(i + k + n) % n] = side;
  });

  // Pit straight: the stretch around the start line, on whichever side has room.
  const probe = at(samples[0], 45, 0);
  const pitSide = grid.clear(probe[0], probe[2], 30) ? 1 : -1;
  const pitRange = new Set();
  for (let k = -55; k <= 55; k++) pitRange.add((k + n) % n);

  // Road, white lines, kerbs, run-off, gravel.
  const road = new Strips();
  const lines = new Strips();
  const kerbs = new Strips();
  const runoff = new Strips();
  const gravel = new Strips();
  const red = new THREE.Color('#c8102e');
  const white = new THREE.Color('#f2f2f2');

  for (let i = 0; i < n; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % n];
    const u1 = a.d / 14;
    const u2 = u1 + STEP / 14;
    road.quad(at(a, -HALF, 0.02), at(b, -HALF, 0.02), at(a, HALF, 0.02), at(b, HALF, 0.02), [[u1, 0], [u2, 0], [u1, 1], [u2, 1]]);

    for (const side of [1, -1]) {
      const edge = side * HALF;
      lines.quad(at(a, edge - side * 0.45, 0.04), at(b, edge - side * 0.45, 0.04), at(a, edge - side * 0.12, 0.04), at(b, edge - side * 0.12, 0.04), [[0, 0], [1, 0], [0, 1], [1, 1]]);

      // Kerbs: raised, red and white, about 1.5 m per stripe.
      let kerbOuter = 0;
      if (a.curv > KERB_CURVATURE) {
        kerbOuter = 1.4;
        for (let half = 0; half < 2; half++) {
          const lerp = (p, q, f) => ({ x: p.x + (q.x - p.x) * f, z: p.z + (q.z - p.z) * f, nx: p.nx, nz: p.nz });
          const pa = lerp(a, b, half / 2);
          const pb = lerp(a, b, (half + 1) / 2);
          const colour = (i * 2 + half) % 2 ? red : white;
          kerbs.quad(at(pa, edge, 0.05), at(pb, edge, 0.05), at(pa, edge + side * 1.4, 0.1), at(pb, edge + side * 1.4, 0.1), [[0, 0], [1, 0], [0, 1], [1, 1]], colour);
        }
      }

      // Tarmac or gravel beyond the kerb, where it won't overlap other track.
      const start = edge + side * kerbOuter;
      const isGravel = gravelSide[i] === side;
      const isPit = side === pitSide && pitRange.has(i);
      const width = isPit ? 16 : isGravel ? 15 : 4.5;
      const outer = edge + side * (kerbOuter + width);
      const pa = at(a, outer, 0);
      const pb = at(b, outer, 0);
      if (!grid.clear(pa[0], pa[2], Math.abs(outer) - 1) || !grid.clear(pb[0], pb[2], Math.abs(outer) - 1)) continue;
      const target = isGravel && !isPit ? gravel : runoff;
      const scale = isGravel ? 5 : 8;
      target.quad(at(a, start, 0.015), at(b, start, 0.015), at(a, outer, 0.015), at(b, outer, 0.015),
        [[a.d / scale, start / scale], [b.d / scale, start / scale], [a.d / scale, outer / scale], [b.d / scale, outer / scale]]);
    }
  }
  group.add(road.mesh(new THREE.MeshStandardMaterial({ map: tex.road, roughness: 0.92 })));
  group.add(lines.mesh(new THREE.MeshStandardMaterial({ color: '#efefef', roughness: 0.7 })));
  if (kerbs.pos.length) group.add(kerbs.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 })));
  group.add(runoff.mesh(new THREE.MeshStandardMaterial({ map: tex.runoff, roughness: 0.95 })));
  if (gravel.pos.length) group.add(gravel.mesh(new THREE.MeshStandardMaterial({ map: tex.gravel, roughness: 1 })));

  // Barriers with advertising boards, and catch fencing above them.
  const boards = new Strips();
  const fence = new Strips();
  const posts = [];
  for (const side of [1, -1]) {
    // Barrier distance from the centreline, smoothed so it doesn't jump around.
    const raw = samples.map((_, i) => {
      if (side === pitSide && pitRange.has(i)) return null;
      return HALF + (gravelSide[i] === side ? 18 : 8);
    });
    const offsets = raw.map((v, i) => {
      if (v == null) return null;
      let sum = 0, count = 0;
      for (let k = -8; k <= 8; k++) {
        const o = raw[(i + k + n) % n];
        if (o != null) { sum += o; count++; }
      }
      return sum / count;
    });
    for (let i = 0; i < n; i++) {
      const oa = offsets[i];
      const ob = offsets[(i + 1) % n];
      if (oa == null || ob == null) continue;
      const a = samples[i];
      const b = samples[(i + 1) % n];
      const pa = at(a, side * oa, 0);
      const pb = at(b, side * ob, 0);
      if (!grid.clear(pa[0], pa[2], oa - 2) || !grid.clear(pb[0], pb[2], ob - 2)) continue;
      const u1 = (side > 0 ? -a.d : a.d) / 48;
      const u2 = u1 + (side > 0 ? -STEP : STEP) / 48;
      const up = (p, y) => [p[0], y, p[2]];
      boards.quad(pa, pb, up(pa, 1.05), up(pb, 1.05), [[u1, 0], [u2, 0], [u1, 1], [u2, 1]]);
      fence.quad(up(pa, 1.05), up(pb, 1.05), up(pa, 4.4), up(pb, 4.4), [[a.d / 2.5, 0], [b.d / 2.5, 0], [a.d / 2.5, 1.4], [b.d / 2.5, 1.4]]);
      if (i % 2 === 0) posts.push(pa);
    }
  }
  const boardMesh = boards.mesh(new THREE.MeshStandardMaterial({ map: tex.boards, roughness: 0.6, side: THREE.DoubleSide }));
  boardMesh.castShadow = true;
  group.add(boardMesh);
  group.add(fence.mesh(new THREE.MeshStandardMaterial({ map: tex.fence, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.6 })));
  if (posts.length) {
    const postMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.09, 4.5, 0.09),
      new THREE.MeshStandardMaterial({ color: '#8f969e', metalness: 0.7, roughness: 0.4 }),
      posts.length
    );
    const m = new THREE.Matrix4();
    posts.forEach((p, i) => postMesh.setMatrixAt(i, m.makeTranslation(p[0], 2.25, p[2])));
    group.add(postMesh);
  }

  // Pit wall, pit building and the start/finish gantry.
  const start = samples[0];
  const heading = Math.atan2(-start.tz, start.tx); // rotates local +x onto the track direction
  const concrete = new THREE.MeshStandardMaterial({ color: '#c9ccd0', roughness: 0.85 });

  const pitWall = new THREE.Mesh(new THREE.BoxGeometry(110 * STEP, 1.1, 0.5), concrete);
  pitWall.position.set(...at(start, pitSide * (HALF + 5), 0.55));
  pitWall.rotation.y = heading;
  pitWall.castShadow = pitWall.receiveShadow = true;
  group.add(pitWall);

  const pitPos = at(start, pitSide * (HALF + 30), 0);
  if (grid.clear(pitPos[0], pitPos[2], 30)) {
    const facade = new THREE.MeshStandardMaterial({ map: tex.pits, roughness: 0.5, metalness: 0.2 });
    const pits = new THREE.Mesh(new THREE.BoxGeometry(300, 12, 18), [concrete, concrete, concrete, concrete, pitSide > 0 ? concrete : facade, pitSide > 0 ? facade : concrete]);
    pits.position.set(pitPos[0], 6, pitPos[2]);
    pits.rotation.y = heading;
    pits.castShadow = pits.receiveShadow = true;
    group.add(pits);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(304, 0.6, 24), new THREE.MeshStandardMaterial({ color: '#eceef1', roughness: 0.6 }));
    roof.position.set(pitPos[0], 12.3, pitPos[2]);
    roof.rotation.y = heading;
    roof.castShadow = true;
    group.add(roof);
    obstacles.push({ x: pitPos[0], z: pitPos[2], r: 160 });
  }

  const line = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2, 1.4), new THREE.MeshStandardMaterial({ map: tex.chequer, roughness: 0.7 }));
  line.rotation.x = -Math.PI / 2;
  line.rotation.z = heading + Math.PI / 2;
  line.position.set(start.x, 0.045, start.z);
  line.receiveShadow = true;
  group.add(line);

  const gantry = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: '#2b3038', metalness: 0.6, roughness: 0.4 });
  for (const s of [1, -1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 9, 0.6), steel);
    post.position.set(0, 4.5, s * (HALF + 2.5));
    post.castShadow = true;
    gantry.add(post);
  }
  const signMat = new THREE.MeshStandardMaterial({ map: tex.gantry, roughness: 0.5, emissive: '#ffffff', emissiveMap: tex.gantry, emissiveIntensity: 0.35 });
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2.2, HALF * 2 + 5.6), [signMat, signMat, steel, steel, steel, steel]);
  sign.position.y = 8.2;
  sign.castShadow = true;
  gantry.add(sign);
  gantry.position.set(start.x, 0, start.z);
  gantry.rotation.y = heading;
  group.add(gantry);

  // Grandstands, spaced around the lap where there's room.
  const seatMat = new THREE.MeshStandardMaterial({ map: tex.crowd, roughness: 0.9 });
  tex.crowd.repeat.set(4, 1);
  const standFrame = new THREE.MeshStandardMaterial({ color: '#dfe3e8', roughness: 0.6 });
  let lastStand = -Infinity;
  for (let i = 0; i < n; i += 6) {
    const p = samples[i];
    if (p.d - lastStand < 320) continue;
    for (const side of [-pitSide, pitSide]) {
      const off = side * (HALF + (gravelSide[i] === side ? 34 : 24));
      const [x, , z] = at(p, off, 0);
      if (!grid.clear(x, z, Math.abs(off) - 6) || obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r)) continue;
      lastStand = p.d;
      const stand = new THREE.Group();
      const rise = 10;
      const depth = 16;
      const tilt = Math.atan2(rise, depth);
      const seats = new THREE.Mesh(new THREE.BoxGeometry(70, 0.4, Math.hypot(rise, depth)), seatMat);
      seats.rotation.x = -tilt;
      seats.position.set(0, rise / 2 + 1, 0);
      const back = new THREE.Mesh(new THREE.BoxGeometry(70, rise + 2, 0.6), standFrame);
      back.position.set(0, (rise + 2) / 2, depth / 2 + 0.3);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(74, 0.5, depth + 6), standFrame);
      roof.position.set(0, rise + 7, -1);
      roof.rotation.x = 0.06;
      stand.add(seats, back, roof);
      for (const px of [-35, -12, 12, 35]) {
        const col = new THREE.Mesh(new THREE.BoxGeometry(0.5, rise + 7, 0.5), standFrame);
        col.position.set(px, (rise + 7) / 2, depth / 2);
        stand.add(col);
      }
      stand.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
      stand.position.set(x, 0, z);
      // Built facing -z; turn it so the seats face the track.
      stand.rotation.y = Math.atan2(-p.tz, p.tx) + (side > 0 ? 0 : Math.PI);
      group.add(stand);
      obstacles.push({ x, z, r: 45 });
      break;
    }
  }

  // Forest: leafy trees and a few conifers, kept clear of the track and buildings.
  const xs = samples.map((p) => p.x);
  const zs = samples.map((p) => p.z);
  const b = { minX: Math.min(...xs) - 450, maxX: Math.max(...xs) + 450, minZ: Math.min(...zs) - 450, maxZ: Math.max(...zs) + 450 };
  const spots = [];
  for (let tries = 0; tries < 9000 && spots.length < 1700; tries++) {
    const x = b.minX + Math.random() * (b.maxX - b.minX);
    const z = b.minZ + Math.random() * (b.maxZ - b.minZ);
    if (!grid.clear(x, z, 34) || obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r)) continue;
    spots.push({ x, z, s: 0.75 + Math.random() * 0.7, conifer: Math.random() < 0.18 });
  }
  const leafy = spots.filter((t) => !t.conifer);
  const conifers = spots.filter((t) => t.conifer);
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshStandardMaterial({ roughness: 0.95 }), leafy.length * 2);
  const cones = new THREE.InstancedMesh(new THREE.ConeGeometry(3, 11, 9), new THREE.MeshStandardMaterial({ roughness: 0.95 }), conifers.length);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.5, 1, 6), new THREE.MeshStandardMaterial({ color: '#4d3a2b', roughness: 1 }), spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  leafy.forEach((t, i) => {
    for (let k = 0; k < 2; k++) {
      const r = (4.2 - k * 1.2) * t.s;
      v.set(t.x + (k ? 1.5 : 0) * t.s, (7 + k * 3.2) * t.s, t.z + (k ? -1 : 0) * t.s);
      sc.set(r, r * 0.85, r);
      q.setFromEuler(new THREE.Euler(0, Math.random() * Math.PI, 0));
      crowns.setMatrixAt(i * 2 + k, m.compose(v, q, sc));
      crowns.setColorAt(i * 2 + k, c.setHSL(0.24 + Math.random() * 0.07, 0.5, 0.2 + Math.random() * 0.09));
    }
  });
  conifers.forEach((t, i) => {
    cones.setMatrixAt(i, m.compose(v.set(t.x, 8 * t.s, t.z), q.identity(), sc.set(t.s, t.s, t.s)));
    cones.setColorAt(i, c.setHSL(0.36 + Math.random() * 0.04, 0.4, 0.16 + Math.random() * 0.06));
  });
  spots.forEach((t, i) => {
    trunks.setMatrixAt(i, m.compose(v.set(t.x, 2.5 * t.s, t.z), q.identity(), sc.set(t.s, 5 * t.s, t.s)));
  });
  for (const mesh of [crowns, cones, trunks]) {
    mesh.castShadow = true;
    group.add(mesh);
  }

  return group;
}

// ---------- Cars ----------
// Each car gets an original livery in its team's real colour, made-up sponsor
// decals, and a unique original helmet for its driver.

const SPONSORS = ['APEXA', 'NORTHLINE', 'VOLTRA', 'KINETIQ', 'SOLARA', 'HELIXON', 'ORBITA', 'CARBONIA', 'MERIDIAN', 'QUANTA', 'ZEPHYRA', 'TRAXIS'];

function hash(str) {
  let h = 2166136261;
  for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function luminance(hex) {
  const v = parseInt(hex.slice(1), 16);
  return 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
}

function mixColour(hex, target, amount) {
  const a = new THREE.Color(hex);
  return '#' + a.lerp(new THREE.Color(target), amount).getHexString();
}

// Colours that go with a team colour: a contrast colour and a lighter accent.
function livery(colour) {
  const light = luminance(colour) > 150;
  return {
    base: colour,
    contrast: light ? '#111419' : '#ffffff',
    accent: light ? mixColour(colour, '#000000', 0.45) : mixColour(colour, '#ffffff', 0.45),
    carbon: '#15171a',
  };
}

// Painted onto the chassis and sidepods using the loft UVs.
// Canvas x = along the car (nose to tail); canvas y = around it (top of the
// canvas is underneath the car, the middle row is its sides, the bottom is the top).
function liveryTexture(colours, seed) {
  return canvasTexture(1024, 512, (ctx, w, h) => {
    const yOf = (v) => (1 - v) * h;
    ctx.fillStyle = colours.carbon;
    ctx.fillRect(0, 0, w, h);
    // Team colour over the top and down the sides, bare carbon underneath.
    ctx.fillStyle = colours.base;
    ctx.fillRect(0, yOf(0.6), w, yOf(-0.0) - yOf(0.6));
    ctx.fillRect(0, yOf(1), w, yOf(0.9) - yOf(1));
    // Pinstripes where colour meets carbon.
    ctx.fillStyle = colours.contrast;
    ctx.fillRect(0, yOf(0.6) - 3, w, 6);
    ctx.fillRect(0, yOf(0.9) - 3, w, 6);
    // Accent sweeps along each side, shaped differently for each team.
    const sweep = 0.12 + (seed % 5) * 0.03;
    ctx.fillStyle = colours.accent;
    for (const side of [0.04, 0.46]) {
      ctx.beginPath();
      ctx.moveTo(w * 0.22, yOf(side));
      ctx.lineTo(w * (0.5 + sweep), yOf(side + 0.05));
      ctx.lineTo(w * 1.0, yOf(side + 0.05));
      ctx.lineTo(w * 1.0, yOf(side - 0.02));
      ctx.lineTo(w * (0.55 + sweep), yOf(side - 0.02));
      ctx.closePath();
      ctx.fill();
    }
    // Centre stripe down the top of the nose.
    ctx.fillStyle = colours.contrast;
    ctx.fillRect(0, yOf(0.27), w * 0.42, yOf(0.23) - yOf(0.27));
    ctx.fillStyle = colours.accent;
    ctx.fillRect(0, yOf(0.258), w * 0.42, yOf(0.242) - yOf(0.258));
  });
}

// A made-up sponsor: a simple emblem and a word, on a transparent background.
function sponsorTexture(name, colour, emblem) {
  return canvasTexture(512, 128, (ctx, w, h) => {
    ctx.fillStyle = colour;
    const cy = h / 2;
    ctx.beginPath();
    if (emblem === 0) ctx.arc(52, cy, 30, 0, Math.PI * 2);
    else if (emblem === 1) { ctx.moveTo(22, cy + 28); ctx.lineTo(52, cy - 30); ctx.lineTo(82, cy + 28); }
    else if (emblem === 2) { ctx.moveTo(52, cy - 32); ctx.lineTo(84, cy); ctx.lineTo(52, cy + 32); ctx.lineTo(20, cy); }
    else { ctx.moveTo(20, cy - 26); ctx.lineTo(56, cy); ctx.lineTo(20, cy + 26); ctx.lineTo(36, cy); }
    ctx.closePath();
    ctx.fill();
    ctx.font = 'italic 900 78px "Big Shoulders Display", "Arial Narrow", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 104, cy + 4);
  });
}

function numberTexture(num, colour = '#fff', outline = '#111') {
  return canvasTexture(128, 96, (ctx, w, h) => {
    ctx.font = 'italic 900 80px "Big Shoulders Display", "Arial Narrow", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = outline;
    ctx.strokeText(String(num), w / 2, h / 2 + 4);
    ctx.fillStyle = colour;
    ctx.fillText(String(num), w / 2, h / 2 + 4);
  });
}

// An original helmet design per driver, picked from a few classic patterns.
// Canvas x goes around the helmet (0.25 = back, 0.5 = right, 0.75 = front);
// canvas y goes top to bottom.
function helmetTexture(driver, colours) {
  const seed = hash(driver.name);
  const palette = ['#ffffff', '#ffd23f', '#e10600', '#1e5bc6', '#111419', '#27f4d2', '#ff87bc', '#7c3aed'];
  const second = palette[seed % palette.length] === colours.base ? palette[(seed + 3) % palette.length] : palette[seed % palette.length];
  const whiteBase = (seed >>> 3) % 2 === 0;
  const base = whiteBase ? '#f4f4f4' : colours.base;
  const main = whiteBase ? colours.base : second;
  const pattern = (seed >>> 5) % 4;
  return canvasTexture(1024, 512, (ctx, w, h) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = main;
    if (pattern === 0) {
      // Bands around the helmet.
      ctx.fillRect(0, h * 0.24, w, h * 0.09);
      ctx.fillRect(0, h * 0.58, w, h * 0.16);
      ctx.fillStyle = second;
      ctx.fillRect(0, h * 0.35, w, h * 0.025);
    } else if (pattern === 1) {
      // Chevrons pointing forward.
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(w * 0.75, h * (0.12 + i * 0.14));
        ctx.lineTo(w * 0.25, h * (0.3 + i * 0.14));
        ctx.lineTo(w * 0.25, h * (0.36 + i * 0.14));
        ctx.lineTo(w * 0.75, h * (0.18 + i * 0.14));
        ctx.lineTo(w * 1.25, h * (0.36 + i * 0.14));
        ctx.lineTo(w * 1.25, h * (0.3 + i * 0.14));
        ctx.closePath();
        ctx.fill();
      }
      ctx.save();
      ctx.translate(-w, 0);
      ctx.restore();
    } else if (pattern === 2) {
      // Two-tone diagonal split.
      ctx.beginPath();
      ctx.moveTo(0, h * 0.2);
      ctx.lineTo(w, h * 0.55);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = second;
      ctx.fillRect(0, h * 0.7, w, h * 0.03);
    } else {
      // Crown with dots trailing back.
      ctx.fillRect(0, 0, w, h * 0.22);
      ctx.fillStyle = second;
      for (let i = 0; i < 18; i++) {
        ctx.beginPath();
        ctx.arc((i / 18) * w + 20, h * (0.3 + (i % 3) * 0.06), 12, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = main;
      ctx.fillRect(0, h * 0.62, w, h * 0.12);
    }
    // Number on both sides, initials on the back.
    ctx.font = 'italic 900 110px "Big Shoulders Display", "Arial Narrow", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 10;
    for (const u of [0.5, 0.0, 1.0]) {
      ctx.strokeStyle = '#111';
      ctx.strokeText(String(driver.driverNumber), u * w, h * 0.55);
      ctx.fillStyle = '#fff';
      ctx.fillText(String(driver.driverNumber), u * w, h * 0.55);
    }
    ctx.font = '800 70px Barlow, system-ui, sans-serif';
    ctx.fillStyle = luminance(base) > 150 ? '#111' : '#fff';
    ctx.fillText(driver.acronym, 0.25 * w, h * 0.46);
  });
}

function visorStripTexture() {
  return canvasTexture(512, 64, (ctx, w, h) => {
    ctx.fillStyle = '#111419';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'italic 900 44px "Big Shoulders Display", "Arial Narrow", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GHOST LAP', w / 2, h / 2 + 2);
  });
}

function buildCar(driver, teammateIndex = 0) {
  const colours = livery(driver.colour);
  const seed = hash(driver.team || driver.colour);
  const group = new THREE.Group(); // position and heading
  const body = new THREE.Group(); // pitch and roll on top of that
  group.add(body);

  const paintProps = { metalness: 0.05, roughness: 0.45, clearcoat: 0.35, clearcoatRoughness: 0.2 };
  const liveryMat = new THREE.MeshPhysicalMaterial({ map: liveryTexture(colours, seed), ...paintProps });
  const paint = new THREE.MeshPhysicalMaterial({ color: colours.base, ...paintProps });
  const contrast = new THREE.MeshPhysicalMaterial({ color: colours.contrast, ...paintProps });
  const accent = new THREE.MeshPhysicalMaterial({ color: colours.accent, ...paintProps });
  const carbon = new THREE.MeshStandardMaterial({ color: colours.carbon, metalness: 0.35, roughness: 0.42 });
  const tyre = new THREE.MeshStandardMaterial({ color: '#1c1c1e', roughness: 0.9 });
  const metal = new THREE.MeshStandardMaterial({ color: '#60656c', metalness: 0.9, roughness: 0.35 });
  const softBand = new THREE.MeshStandardMaterial({ color: '#e10600', roughness: 0.6 });
  const visor = new THREE.MeshPhysicalMaterial({ color: '#0b0d10', metalness: 0.7, roughness: 0.08, clearcoat: 1 });
  const helmetMat = new THREE.MeshPhysicalMaterial({ map: helmetTexture(driver, colours), roughness: 0.25, clearcoat: 1 });
  const stripMat = new THREE.MeshStandardMaterial({ map: visorStripTexture(), roughness: 0.4 });
  // Real broadcasts mark teammates apart with the T-cam colour: black for one, yellow for the other.
  const tcamMat = new THREE.MeshStandardMaterial({ color: teammateIndex ? '#ffd400' : '#111111', roughness: 0.5 });
  const rearLight = new THREE.MeshStandardMaterial({ color: '#400', emissive: '#ff1a1a', emissiveIntensity: 2 });
  const mats = [liveryMat, paint, contrast, accent, carbon, tyre, metal, softBand, visor, helmetMat, stripMat, tcamMat, rearLight];
  const decalMats = []; // always see-through around the lettering

  const add = (parent, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const box = (w, h, l) => new THREE.BoxGeometry(w, h, l);
  const decal = (texture, w, h, x, y, z, ry, rx = 0) => {
    const mat = new THREE.MeshStandardMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, roughness: 0.4 });
    decalMats.push(mat);
    mats.push(mat);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0, 'YXZ');
    body.add(m);
    return m;
  };

  // Chassis: a long drooping nose flowing into the cockpit and engine cover.
  add(body, loft([
    { z: -3.04, w: 0.12, h: 0.08, y: 0.2 },
    { z: -2.85, w: 0.2, h: 0.13, y: 0.22 },
    { z: -2.5, w: 0.27, h: 0.18, y: 0.26 },
    { z: -2.0, w: 0.33, h: 0.24, y: 0.31 },
    { z: -1.5, w: 0.4, h: 0.29, y: 0.36 },
    { z: -1.0, w: 0.52, h: 0.36, y: 0.4 },
    { z: -0.55, w: 0.64, h: 0.43, y: 0.43 },
    { z: 0.0, w: 0.72, h: 0.48, y: 0.45 },
    { z: 0.55, w: 0.74, h: 0.6, y: 0.5 },
    { z: 1.1, w: 0.6, h: 0.58, y: 0.53 },
    { z: 1.6, w: 0.42, h: 0.46, y: 0.49 },
    { z: 2.0, w: 0.26, h: 0.3, y: 0.42 },
    { z: 2.3, w: 0.14, h: 0.16, y: 0.38 },
  ]), liveryMat);

  // Sidepods: wide at the inlets, tapering hard towards the back ("coke bottle").
  add(body, loft([
    { z: -0.62, w: 1.2, h: 0.2, y: 0.38 },
    { z: -0.45, w: 1.5, h: 0.34, y: 0.37 },
    { z: 0.0, w: 1.56, h: 0.38, y: 0.37 },
    { z: 0.6, w: 1.46, h: 0.36, y: 0.35 },
    { z: 1.15, w: 1.1, h: 0.28, y: 0.3 },
    { z: 1.6, w: 0.66, h: 0.2, y: 0.26 },
    { z: 2.0, w: 0.32, h: 0.13, y: 0.22 },
  ], 28, 4), liveryMat);
  for (const sd of [1, -1]) {
    add(body, box(0.2, 0.2, 0.05), carbon, sd * 0.6, 0.39, -0.64); // sidepod inlets
  }

  // Airbox, shark fin and T-cam pod.
  add(body, loft([
    { z: 0.34, w: 0.28, h: 0.22, y: 0.97 },
    { z: 0.7, w: 0.3, h: 0.3, y: 0.92 },
    { z: 1.2, w: 0.22, h: 0.26, y: 0.82 },
    { z: 1.8, w: 0.1, h: 0.14, y: 0.62 },
  ], 16), paint);
  add(body, new THREE.PlaneGeometry(0.17, 0.11), carbon, 0, 0.975, 0.335, 0, Math.PI); // intake, facing forward
  add(body, box(0.014, 0.22, 1.05), paint, 0, 0.88, 1.55, -0.12);
  const tcamPod = add(body, box(0.12, 0.05, 0.1), tcamMat, 0, 1.11, 0.45);

  // Floor, edge wings and diffuser with strakes.
  add(body, box(1.7, 0.03, 3.5), carbon, 0, 0.07, 0.3);
  for (const sd of [1, -1]) add(body, box(0.12, 0.08, 1.8), carbon, sd * 0.86, 0.1, 0.55, 0, 0, sd * 0.25);
  add(body, box(1.1, 0.03, 0.5), carbon, 0, 0.14, 2.25, 0.35);
  for (let i = -2; i <= 2; i++) add(body, box(0.01, 0.16, 0.48), carbon, i * 0.22, 0.14, 2.24, 0.35);

  // Front wing: four elements that sweep up at the outer ends.
  for (let e = 0; e < 4; e++) {
    const y = 0.085 + e * 0.035;
    const z = -2.92 + e * 0.11;
    const depth = 0.24 - e * 0.04;
    const mat = e % 2 ? paint : carbon;
    add(body, box(0.72, 0.018, depth), mat, 0, y, z, 0.12 + e * 0.13);
    for (const sd of [1, -1]) add(body, box(0.66, 0.018, depth), mat, sd * 0.68, y + e * 0.022, z, 0.12 + e * 0.13, 0, sd * 0.06);
  }
  for (const sd of [1, -1]) {
    add(body, box(0.025, 0.28, 0.64), contrast, sd * 1.01, 0.17, -2.8);
    add(body, box(0.1, 0.16, 0.22), carbon, sd * 0.62, 0.36, -1.85); // front brake ducts
  }

  // Rear wing: endplates, main plane, DRS flap, swan-neck pylon, beam wing.
  for (const sd of [1, -1]) add(body, box(0.025, 0.64, 0.64), paint, sd * 0.51, 0.72, 2.42);
  add(body, box(1.0, 0.025, 0.36), carbon, 0, 0.84, 2.44, -0.1);
  add(body, box(1.0, 0.02, 0.22), contrast, 0, 0.98, 2.35, -0.55);
  add(body, box(0.03, 0.12, 0.36), carbon, 0, 0.9, 2.2, 0.6); // swan neck
  add(body, box(0.05, 0.4, 0.1), carbon, 0, 0.6, 2.32);
  add(body, box(0.9, 0.02, 0.18), carbon, 0, 0.44, 2.46, -0.15);
  add(body, box(0.9, 0.02, 0.14), carbon, 0, 0.5, 2.36, -0.4);
  add(body, box(0.1, 0.05, 0.02), rearLight, 0, 0.3, 2.63);

  // Mirrors on stalks.
  for (const sd of [1, -1]) {
    body.add(rod([sd * 0.3, 0.62, -0.75], [sd * 0.48, 0.67, -0.8], 0.012, carbon));
    add(body, new THREE.SphereGeometry(1, 20, 12), paint, sd * 0.51, 0.68, -0.8).scale.set(0.095, 0.036, 0.045);
    add(body, new THREE.PlaneGeometry(0.15, 0.05), metal, sd * 0.51, 0.68, -0.757);
  }

  // Halo with a painted top fairing.
  const halo = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.42, 0.68, 0.55),
    new THREE.Vector3(-0.4, 1.1, 0.0),
    new THREE.Vector3(0, 1.2, -0.36),
    new THREE.Vector3(0.4, 1.1, 0.0),
    new THREE.Vector3(0.42, 0.68, 0.55),
  ]);
  add(body, new THREE.TubeGeometry(halo, 48, 0.034, 10), carbon);
  const pillar = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.52, -0.95), new THREE.Vector3(0, 0.92, -0.62), new THREE.Vector3(0, 1.2, -0.36)]);
  add(body, new THREE.TubeGeometry(pillar, 16, 0.03, 10), paint);

  // Helmet: the driver's own design, with a dark visor and a strip above it.
  const helmet = new THREE.Group();
  const shell = add(helmet, new THREE.SphereGeometry(0.15, 32, 24), helmetMat);
  shell.scale.set(1, 1, 1.08);
  add(helmet, new THREE.SphereGeometry(0.152, 32, 8, Math.PI * 1.5 - 0.95, 1.9, 1.22, 0.4), visor).scale.set(1, 1, 1.08);
  add(helmet, new THREE.SphereGeometry(0.1525, 32, 4, Math.PI * 1.5 - 0.95, 1.9, 1.08, 0.14), stripMat).scale.set(1, 1, 1.08);
  helmet.position.set(0, 0.86, 0.2);
  body.add(helmet);

  // Steering wheel with shift lights.
  const steering = new THREE.Group();
  add(steering, box(0.3, 0.13, 0.04), carbon);
  const leds = [];
  for (let i = 0; i < 10; i++) {
    const led = new THREE.Mesh(box(0.018, 0.014, 0.01), new THREE.MeshBasicMaterial({ color: '#222' }));
    led.position.set(-0.1 + i * 0.022, 0.045, -0.025);
    steering.add(led);
    leds.push(led);
  }
  const wheelPivot = new THREE.Group();
  wheelPivot.position.set(0, 0.66, -0.33);
  wheelPivot.rotation.x = -0.5;
  wheelPivot.add(steering);
  body.add(wheelPivot);

  // Made-up sponsors, two per team, plus the race number.
  const s1 = SPONSORS[seed % SPONSORS.length];
  const s2 = SPONSORS[(seed >>> 4) % SPONSORS.length] === s1 ? SPONSORS[(seed + 5) % SPONSORS.length] : SPONSORS[(seed >>> 4) % SPONSORS.length];
  const t1 = sponsorTexture(s1, colours.contrast, seed % 4);
  const t2 = sponsorTexture(s2, colours.contrast, (seed >>> 2) % 4);
  for (const sd of [1, -1]) {
    const face = sd * Math.PI / 2;
    decal(t1, 0.78, 0.195, sd * 0.785, 0.4, 0.05, face); // sidepods
    decal(t2, 0.46, 0.115, sd * 0.31, 0.56, 1.1, face); // engine cover
    decal(t1, 0.5, 0.125, sd * 0.524, 0.86, 2.42, face); // rear wing endplates
    decal(t2, 0.44, 0.11, sd * 1.024, 0.19, -2.8, face); // front wing endplates
    decal(t2, 0.44, 0.11, sd * 0.188, 0.34, -1.75, face); // nose sides
  }
  decal(t1, 0.86, 0.215, 0, 0.995, 2.35, 0, -Math.PI / 2 - 0.55); // DRS flap, top
  // Sidepod tops: the sponsors you see from the onboard cameras.
  for (const sd of [1, -1]) {
    decal(sd > 0 ? t1 : t2, 0.44, 0.11, sd * 0.52, 0.562, -0.3, 0, -Math.PI / 2);
    decal(sd > 0 ? t2 : t1, 0.4, 0.1, sd * 0.5, 0.548, 0.55, 0, -Math.PI / 2);
  }
  // Halo top and nose, along their length.
  decal(t2, 0.34, 0.085, 0, 1.237, -0.18, 0, -Math.PI / 2 + 0.25);
  for (const sd of [1, -1]) decal(t1, 0.42, 0.105, sd * 0.11, 0.52, -1.3, Math.PI / 2, -Math.PI / 2);
  decal(numberTexture(driver.driverNumber, colours.contrast, colours.base), 0.2, 0.15, 0, 0.402, -2.2, Math.PI, -Math.PI / 2); // nose

  // Wheels: rounded tyres with soft-compound red bands and wheel covers.
  const wheels = [];
  const steerers = [];
  for (const [x, z, w, front] of [[0.86, -1.85, 0.36, true], [-0.86, -1.85, 0.36, true], [0.84, 1.75, 0.42, false], [-0.84, 1.75, 0.42, false]]) {
    const R = 0.36;
    const steer = new THREE.Group();
    steer.position.set(x, R, z);
    group.add(steer);
    const spin = new THREE.Group();
    steer.add(spin);
    const h = w / 2;
    const profile = [[0.235, -h], [0.32, -h], [0.348, -h + 0.03], [R, -h + 0.08], [R, h - 0.08], [0.348, h - 0.03], [0.32, h], [0.235, h]]
      .map(([r, y]) => new THREE.Vector2(r, y));
    const tyreGeo = new THREE.LatheGeometry(profile, 40);
    tyreGeo.rotateZ(Math.PI / 2);
    add(spin, tyreGeo, tyre);
    const rim = new THREE.CylinderGeometry(0.235, 0.235, w - 0.01, 32);
    rim.rotateZ(Math.PI / 2);
    add(spin, rim, metal);
    const out = Math.sign(x);
    add(spin, new THREE.CircleGeometry(0.236, 32), carbon, out * (h + 0.002), 0, 0, 0, out * Math.PI / 2);
    add(spin, new THREE.RingGeometry(0.285, 0.305, 48), softBand, out * (h + 0.003), 0, 0, 0, out * Math.PI / 2);
    add(spin, new THREE.RingGeometry(0.2, 0.236, 32), paint, out * (h + 0.004), 0, 0, 0, out * Math.PI / 2);
    wheels.push(spin);
    if (front) steerers.push(steer);

    // Suspension arms from the chassis to the wheel.
    const hub = x - out * (h + 0.02);
    const inner = front ? 0.19 : 0.3;
    const zA = front ? z - 0.22 : z - 0.28;
    const zB = front ? z + 0.28 : z + 0.24;
    group.add(rod([out * inner, 0.46, zA], [hub, 0.47, z], 0.016, carbon));
    group.add(rod([out * inner, 0.46, zB], [hub, 0.47, z], 0.016, carbon));
    group.add(rod([out * inner, 0.27, zA], [hub, 0.24, z], 0.016, carbon));
    group.add(rod([out * inner, 0.27, zB], [hub, 0.24, z], 0.016, carbon));
  }

  // Soft shadow underneath, so the car always looks planted.
  const blobMat = new THREE.MeshBasicMaterial({ map: getTextures().blob, transparent: true, depthWrite: false, opacity: 0.55 });
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 6.2), blobMat);
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.035;
  group.add(blob);

  // Floating name tag, like the broadcast car trackers.
  const tagTex = canvasTexture(160, 56, (ctx, w, h) => {
    ctx.fillStyle = 'rgba(16,19,24,0.9)';
    ctx.beginPath();
    ctx.roundRect(2, 2, w - 4, h - 4, 6);
    ctx.fill();
    ctx.fillStyle = colours.base;
    ctx.fillRect(2, 2, 10, h - 4);
    ctx.fillStyle = '#fff';
    ctx.font = '700 30px Barlow, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(driver.acronym, 24, h / 2 + 1);
  });
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTex, depthTest: false, sizeAttenuation: false }));
  tag.scale.set(0.08, 0.028, 1);
  tag.position.y = 2.1;
  tag.renderOrder = 10;
  group.add(tag);

  return { group, body, tcamPod, mats, decalMats, wheels, steerers, steering, helmet, leds, tag, blob, heading: 0, steer: 0, pitch: 0, roll: 0, spin: 0 };
}

function setGhost(car, ghost) {
  for (const m of car.mats) {
    const isDecal = car.decalMats.includes(m);
    m.transparent = ghost || isDecal;
    m.opacity = ghost ? 0.36 : 1;
    m.depthWrite = !ghost && !isDecal;
    m.needsUpdate = true;
  }
  car.group.traverse((o) => {
    if (o.isMesh && o !== car.blob) o.castShadow = !ghost;
  });
  car.blob.material.opacity = ghost ? 0.2 : 0.45;
  car.tag.visible = ghost;
  car.steering.visible = !ghost;
}

// ---------- Racing line ----------

// A ribbon along the driver's actual line, coloured by what they're doing:
// green on the throttle, yellow lifting or coasting, red on the brakes.
function buildRacingLine(driver, toWorld) {
  const green = new THREE.Color('#25e06a');
  const yellow = new THREE.Color('#ffc21a');
  const red = new THREE.Color('#ff2b2b');
  const pts = [];
  for (let t = 0; t <= driver.duration; t += 60) {
    const p = toWorld(driver.posAt(t));
    const c = driver.carAt(t);
    pts.push({ ...p, colour: c.brake ? red : c.throttle >= 85 ? green : yellow });
  }
  const pos = [];
  const col = [];
  const idx = [];
  const half = 0.3;
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / len;
    const nz = (b.x - a.x) / len;
    pos.push(p.x - nx * half, 0.065, p.z - nz * half, p.x + nx * half, 0.065, p.z + nz * half);
    col.push(p.colour.r, p.colour.g, p.colour.b, p.colour.r, p.colour.g, p.colour.b);
    if (i < pts.length - 1) {
      const v = i * 2;
      idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  }));
  mesh.renderOrder = 2;
  return mesh;
}

// ---------- The view ----------

export class OnboardView {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // Neutral tone mapping keeps team colours true instead of washing them out.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.78;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'onboard-canvas';
    maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    container.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog('#b9cadb', 600, 4200);

    // Physically based sky, plus the same sky as reflections on the cars.
    const makeSky = (size) => {
      const sky = new Sky();
      sky.scale.setScalar(size);
      const u = sky.material.uniforms;
      u.turbidity.value = 5;
      u.rayleigh.value = 1.4;
      u.mieCoefficient.value = 0.004;
      u.mieDirectionalG.value = 0.86;
      u.sunPosition.value.copy(SUN);
      return sky;
    };
    this.scene.add(makeSky(8000));
    const envScene = new THREE.Scene();
    envScene.add(makeSky(1000));
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(envScene, 0, 0.1, 3000).texture;
    this.scene.environmentIntensity = 0.32; // the sky is very bright; keep reflections in check
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight('#c4d8ff', '#3e5a2f', 0.45));
    this.sun = new THREE.DirectionalLight('#fff1dc', 2.9);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -22;
    sc.right = sc.top = 22;
    sc.near = 1;
    sc.far = 600;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.camera = new THREE.PerspectiveCamera(56, 1, 0.1, 12000);
    this.cameraIndex = 0;
    this.viewIndex = 0;
    this.cars = [];
    this.drivers = [];
    this.lastT = null;
    this.lastWall = null;
    this.speedFov = 0;
    this.showLine = true;
    this.lines = [];

    // Chase cam orbit: drag to swing around the car, scroll to zoom,
    // double-click to snap back behind it.
    this.orbitHome = { azimuth: 0, polar: 1.355, radius: 8.4 };
    this.orbit = { ...this.orbitHome };
    this.setupOrbit();

    this.buildHud();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  buildHud() {
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <div class="hud-top-left">
        <div class="hud-bug">
          <span class="hud-mark" aria-hidden="true"></span>
          <span class="hud-brand">F1 Ghost Lap</span>
          <span class="hud-replay"><i></i>Replay</span>
        </div>
        <ol class="hud-tower"></ol>
      </div>
      <div class="hud-clock">
        <div class="hud-laptime">0.000</div>
        <div class="hud-sectors">
          <span data-s="0">S1</span><span data-s="1">S2</span><span data-s="2">S3</span>
        </div>
      </div>
      <div class="hud-onboard">
        <div class="hud-driver">
          <span class="hud-driver-bar"></span>
          <span class="hud-driver-num"></span>
          <span class="hud-driver-name"></span>
          <span class="hud-driver-team"></span>
        </div>
        <div class="hud-dash">
          <div class="hud-speed"><b>0</b><span>km/h</span></div>
          <div class="hud-gear"><span>Gear</span><b>N</b></div>
          <div class="hud-rpm" aria-hidden="true">${'<i></i>'.repeat(15)}</div>
          <div class="hud-pedals">
            <span class="hud-pedal"><i class="hud-throttle"></i></span>
            <span class="hud-pedal"><i class="hud-brake"></i></span>
          </div>
        </div>
      </div>
      <div class="hud-switch">
        <div class="hud-group" role="group" aria-label="Onboard with"></div>
        <div class="hud-group" role="group" aria-label="Camera">
          ${CAMERAS.map((c, i) => `<button type="button" data-cam="${i}" aria-pressed="${i === 0}">${c.label}</button>`).join('')}
        </div>
        <div class="hud-group">
          <button type="button" class="hud-line-btn" aria-pressed="true">Racing line</button>
        </div>
      </div>`;
    this.container.append(hud);

    const q = (s) => hud.querySelector(s);
    this.hud = {
      tower: q('.hud-tower'),
      laptime: q('.hud-laptime'),
      sectors: [...hud.querySelectorAll('[data-s]')],
      bar: q('.hud-driver-bar'),
      num: q('.hud-driver-num'),
      name: q('.hud-driver-name'),
      team: q('.hud-driver-team'),
      speed: q('.hud-speed b'),
      gear: q('.hud-gear b'),
      rpm: [...hud.querySelectorAll('.hud-rpm i')],
      throttle: q('.hud-throttle'),
      brake: q('.hud-brake'),
      driverGroup: q('.hud-switch .hud-group'),
      camButtons: [...hud.querySelectorAll('[data-cam]')],
      lineButton: q('.hud-line-btn'),
      rows: new Map(),
    };
    this.hud.camButtons.forEach((b) => b.addEventListener('click', () => this.setCamera(Number(b.dataset.cam))));
    this.hud.lineButton.addEventListener('click', () => this.setRacingLine(!this.showLine));
  }

  setupOrbit() {
    const el = this.renderer.domElement;
    let drag = null;
    const isOrbit = () => CAMERAS[this.cameraIndex].orbit;
    el.addEventListener('pointerdown', (e) => {
      if (!isOrbit()) return;
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
      this.container.classList.add('is-dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.orbit.azimuth -= (e.clientX - drag.x) * 0.008;
      this.orbit.polar = clamp(this.orbit.polar - (e.clientY - drag.y) * 0.006, 0.3, 1.5);
      drag = { x: e.clientX, y: e.clientY };
      this.onChange?.();
    });
    const end = () => {
      drag = null;
      this.container.classList.remove('is-dragging');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      if (!isOrbit()) return;
      e.preventDefault();
      this.orbit.radius = clamp(this.orbit.radius * (1 + e.deltaY * 0.001), 4, 24);
      this.onChange?.();
    }, { passive: false });
    el.addEventListener('dblclick', () => {
      if (!isOrbit()) return;
      this.orbit = { ...this.orbitHome };
      this.onChange?.();
    });
  }

  // Place the chase camera on a sphere around the car and aim it at the car.
  updateOrbitCamera(car) {
    const { azimuth, polar, radius } = this.orbit;
    const target = new THREE.Vector3(0, 0.7, 0);
    this.camera.position.set(
      target.x + radius * Math.sin(polar) * Math.sin(azimuth),
      target.y + radius * Math.cos(polar),
      target.z + radius * Math.sin(polar) * Math.cos(azimuth)
    );
    car.group.updateMatrixWorld(true);
    this.camera.lookAt(car.body.localToWorld(target));
  }

  setData({ drivers, sectorTimes }) {
    if (this.world) {
      this.scene.remove(this.world);
      disposeTree(this.world);
    }
    this.drivers = drivers;
    this.sectorTimes = sectorTimes;
    this.lastT = null;

    const ref = drivers[0];
    const s = ref.metresPerUnit;
    const cx = ref.outline.reduce((a, p) => a + p.x, 0) / ref.outline.length;
    const cy = ref.outline.reduce((a, p) => a + p.y, 0) / ref.outline.length;
    this.toWorld = (p) => ({ x: (p.x - cx) * s, z: -(p.y - cy) * s });

    const line = prepareCentreline(ref.outline.map(this.toWorld)).samples;
    const { samples } = prepareCentreline(deriveTrackCentre(line));
    this.world = new THREE.Group();
    this.world.add(buildCircuit(samples));
    this.cars = drivers.map((d) => {
      const car = buildCar(d, d.ring ? 1 : 0);
      this.world.add(car.group);
      return car;
    });
    this.lines = drivers.map((d) => {
      const line = buildRacingLine(d, this.toWorld);
      this.world.add(line);
      return line;
    });
    this.scene.add(this.world);

    // Timing tower rows, built once and updated in place each frame.
    this.hud.tower.innerHTML = '';
    this.hud.rows.clear();
    for (const d of drivers) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="p"></span><span class="c" style="background:${d.colour}"></span><span class="n">${d.acronym}</span><span class="g"></span>`;
      this.hud.tower.append(li);
      this.hud.rows.set(d, { li, p: li.querySelector('.p'), g: li.querySelector('.g') });
    }

    this.hud.driverGroup.innerHTML = drivers
      .map((d, i) => `<button type="button" data-view="${i}" aria-pressed="${i === 0}" style="--c:${d.colour}">${d.acronym}</button>`)
      .join('');
    this.hud.driverGroup.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => this.setDriver(Number(b.dataset.view)))
    );
    this.setDriver(0);
  }

  setDriver(i) {
    if (!this.cars.length) return;
    this.viewIndex = (i + this.cars.length) % this.cars.length;
    this.cars.forEach((car, j) => setGhost(car, j !== this.viewIndex));
    this.lines.forEach((line, j) => (line.visible = this.showLine && j === this.viewIndex));
    this.cars[this.viewIndex].body.add(this.camera); // onboard cameras pitch and roll with the car
    this.hud.driverGroup.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-pressed', String(j === this.viewIndex)));
    const d = this.drivers[this.viewIndex];
    this.hud.bar.style.background = d.colour;
    this.hud.num.textContent = d.driverNumber;
    this.hud.name.textContent = d.name;
    this.hud.team.textContent = d.team;
    this.setCamera(this.cameraIndex);
  }

  setCamera(i) {
    this.cameraIndex = (i + CAMERAS.length) % CAMERAS.length;
    const cam = CAMERAS[this.cameraIndex];
    this.camera.position.set(...cam.pos);
    this.camera.rotation.set(cam.pitch, 0, 0);
    this.applyFov();
    const own = this.cars[this.viewIndex];
    if (own) {
      own.helmet.visible = cam.id !== 'cockpit';
      own.tcamPod.visible = cam.id !== 'tcam'; // the camera is mounted on it
    }
    this.hud.camButtons.forEach((b, j) => b.setAttribute('aria-pressed', String(j === this.cameraIndex)));
    this.container.classList.toggle('is-orbit', Boolean(cam.orbit));
    this.onChange?.();
  }

  setRacingLine(on) {
    this.showLine = on;
    this.lines.forEach((line, j) => (line.visible = on && j === this.viewIndex));
    this.hud.lineButton.setAttribute('aria-pressed', String(on));
    this.onChange?.();
  }

  // Tall phone screens get a wider angle; speed widens it a touch, like a real onboard.
  applyFov() {
    const base = CAMERAS[this.cameraIndex].fov;
    const aspect = this.camera.aspect || 1.6;
    const fov = aspect < 1.2 ? Math.min(95, base * (1.2 / aspect) ** 0.6) : base;
    this.camera.fov = fov + this.speedFov;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyFov();
    this.container.classList.toggle('hud-compact', w < 700);
    if (this.lastT != null) this.draw(this.lastT, this.lastRows, true);
  }

  draw(t, rows, force = false) {
    if (!this.cars.length || !this.container.clientWidth) return;
    const now = performance.now();
    const wallDt = this.lastWall == null ? 16 : clamp(now - this.lastWall, 0, 100);
    this.lastWall = now;
    const jumped = this.lastT == null || Math.abs(t - this.lastT) > 600;
    const lapDt = jumped ? 0 : t - this.lastT;
    this.lastT = t;
    this.lastRows = rows;
    // Smoothing factor that behaves the same at any frame rate.
    const ease = (tau) => (jumped || force ? 1 : 1 - Math.exp(-wallDt / tau));

    this.drivers.forEach((d, i) => {
      const car = this.cars[i];
      const ct = Math.min(t, d.duration);
      const p = this.toWorld(d.posAt(ct));
      const back = this.toWorld(d.posAt(Math.max(0, ct - 220)));
      const ahead = this.toWorld(d.posAt(Math.min(d.duration, ct + 220)));
      const target = Math.atan2(-(ahead.x - back.x), -(ahead.z - back.z));
      car.heading = angleLerp(car.heading, target, ease(70));
      car.group.position.set(p.x, 0, p.z);
      car.group.rotation.y = car.heading;

      const state = d.carAt(ct);
      const v = state.speed / 3.6;

      // How sharply the path bends here (positive = turning left).
      const h1 = Math.atan2(-(p.x - back.x), -(p.z - back.z));
      const h2 = Math.atan2(-(ahead.x - p.x), -(ahead.z - p.z));
      let bend = h2 - h1;
      while (bend > Math.PI) bend -= Math.PI * 2;
      while (bend < -Math.PI) bend += Math.PI * 2;
      const span = Math.hypot(ahead.x - back.x, ahead.z - back.z);
      const curvature = span > 2 ? (bend / span) * 2 : 0;
      car.steer += (clamp(Math.atan(3.6 * curvature) * 1.4, -0.4, 0.4) - car.steer) * ease(90);
      car.steerers.forEach((s) => (s.rotation.y = car.steer));
      car.steering.rotation.z = car.steer * 3.2;

      // Nose dives under braking, squats under power, leans in corners.
      const accel = (d.carAt(Math.min(ct + 150, d.duration)).speed - d.carAt(Math.max(ct - 150, 0)).speed) / 3.6 / 0.3;
      car.pitch += (clamp(accel * 0.0007, -0.016, 0.007) - car.pitch) * ease(120);
      car.roll += (clamp(-v * v * curvature * 0.0005, -0.014, 0.014) - car.roll) * ease(120);
      car.body.rotation.set(car.pitch, 0, car.roll);

      car.spin += (v * (lapDt / 1000)) / 0.36;
      car.wheels.forEach((w) => (w.rotation.x = -car.spin));

      if (i === this.viewIndex) {
        const share = clamp((state.rpm - 9500) / 2700, 0, 1);
        car.leds.forEach((led, k) => {
          const on = k < Math.round(share * 10);
          led.material.color.set(on ? (k < 4 ? '#22e06b' : k < 8 ? '#ff3131' : '#4f7cff') : '#222');
        });
      }
    });

    const own = this.drivers[this.viewIndex];
    const ownCar = this.cars[this.viewIndex];
    const ownState = own.carAt(Math.min(t, own.duration));

    // Ghosts fade out as they get close, so they never fill the screen.
    this.cars.forEach((car, i) => {
      if (i === this.viewIndex) return;
      const dist = car.group.position.distanceTo(ownCar.group.position);
      const fade = clamp((dist - 4) / 14, 0, 1);
      for (const m of car.mats) m.opacity = 0.38 * fade;
      car.blob.material.opacity = 0.2 * fade;
    });

    // Shadows follow the car you're riding with.
    this.sun.target.position.copy(ownCar.group.position);
    this.sun.position.copy(ownCar.group.position).addScaledVector(SUN, 300);

    this.speedFov += ((ownState.speed / 340) * 5 - this.speedFov) * ease(400);
    this.applyFov();

    if (CAMERAS[this.cameraIndex].orbit) {
      this.updateOrbitCamera(ownCar);
    } else if (!reduceMotion) {
      // A little vibration at speed, like a real onboard camera.
      const base = CAMERAS[this.cameraIndex].pos;
      const amount = (ownState.speed / 340) * (CAMERAS[this.cameraIndex].id === 'chase' ? 0.4 : 1);
      this.camera.position.y = base[1] + (Math.sin(t / 29) * 0.004 + Math.sin(t / 13.7) * 0.0025) * amount;
    }

    this.updateHud(t, rows, own, ownState);
    this.renderer.render(this.scene, this.camera);
  }

  updateHud(t, rows, own, state) {
    const h = this.hud;
    rows.forEach((r, i) => {
      const row = h.rows.get(r.d);
      if (!row) return;
      row.li.style.order = i;
      row.li.classList.toggle('is-viewing', r.d === own);
      row.p.textContent = i + 1;
      row.g.textContent = r.finished ? formatLapTime(r.d.duration) : i === 0 ? 'Interval' : formatGap(r.gap);
    });

    const ct = Math.min(t, own.duration);
    h.laptime.textContent = formatLapTime(ct);
    h.laptime.classList.toggle('is-done', t >= own.duration);

    // Sector boxes: purple if it's the best of the three laps, yellow if not.
    let elapsed = 0;
    h.sectors.forEach((el, i) => {
      const s = own.sectors[i];
      const end = i === 2 ? own.duration : elapsed + (s ?? 0);
      const best = Math.min(...this.drivers.map((d) => d.sectors[i] ?? Infinity));
      let text = `S${i + 1}`;
      let cls = '';
      if (s != null && ct >= end - 1) {
        text = formatSector(s);
        cls = s <= best ? 'is-best' : 'is-slower';
      } else if (ct >= elapsed) {
        cls = 'is-live';
      }
      if (el.textContent !== text) el.textContent = text;
      if (el.className !== cls) el.className = cls;
      elapsed = end;
    });

    h.speed.textContent = Math.round(state.speed);
    h.gear.textContent = state.gear || 'N';
    const lit = Math.round(clamp((state.rpm - 8000) / 4200, 0, 1) * 15);
    h.rpm.forEach((el, i) => el.classList.toggle('on', i < lit));
    h.throttle.style.height = `${state.throttle}%`;
    h.brake.style.height = state.brake ? '100%' : '0%';
  }
}