// First-person onboard view, styled like a TV broadcast.
// The circuit is built in 3D from the fastest car's real path. The car you're
// riding with is solid; the other two laps are see-through "ghosts".

import * as THREE from 'three';
import { formatLapTime, formatGap, formatSector } from './format.js';

const ROAD_WIDTH = 13; // metres
const STEP = 3; // metres between track samples
const KERB_CURVATURE = 1 / 90; // corners tighter than a 90 m radius get kerbs

export const CAMERAS = [
  { id: 'cockpit', label: 'Cockpit', pos: [0, 0.92, 0.2], pitch: -0.03, fov: 64 },
  { id: 'tcam', label: 'T-cam', pos: [0, 1.55, 1.0], pitch: -0.11, fov: 60 },
  { id: 'chase', label: 'Chase', pos: [0, 2.8, 8.5], pitch: -0.15, fov: 58 },
];

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Small helpers ----------

function canvasTexture(width, height, paint, repeat = false) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  paint(c.getContext('2d'), width, height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
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
      m.map?.dispose();
      m.dispose();
    });
  });
}

// Closed loop of {x, z} points: smooth it, then resample every STEP metres.
function prepareCentreline(points) {
  let pts = points;
  for (let pass = 0; pass < 2; pass++) {
    const n = pts.length;
    pts = pts.map((_, i) => {
      let x = 0, z = 0;
      for (let k = -4; k <= 4; k++) {
        const p = pts[(i + k + n) % n];
        x += p.x;
        z += p.z;
      }
      return { x: x / 9, z: z / 9 };
    });
  }

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
    p.nx = -p.tz; // sideways normal (points to the driver's right)
    p.nz = p.tx;
  });
  out.forEach((p, i) => {
    const a = out[(i - 2 + n) % n];
    const b = out[(i + 2) % n];
    const turn = Math.atan2(a.tx * b.tz - a.tz * b.tx, a.tx * b.tx + a.tz * b.tz);
    p.curv = Math.abs(turn) / (4 * STEP);
  });
  return { samples: out, length };
}

// Flat band along the track between two sideways offsets.
function bandGeometry(samples, offA, offB, y, uMetres) {
  const pos = [];
  const uv = [];
  const idx = [];
  const n = samples.length;
  for (let i = 0; i <= n; i++) {
    const p = samples[i % n];
    const d = i === n ? samples[n - 1].d + STEP : p.d;
    pos.push(p.x + p.nx * offA, y, p.z + p.nz * offA, p.x + p.nx * offB, y, p.z + p.nz * offB);
    uv.push(d / uMetres, 0, d / uMetres, 1);
    if (i < n) {
      const v = i * 2;
      idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------- Scenery ----------

const textures = {};
function getTextures() {
  if (textures.grass) return textures;
  textures.grass = canvasTexture(256, 256, (ctx, w, h) => {
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? '#4f9142' : '#468538';
      ctx.fillRect(0, (i * h) / 8, w, h / 8);
    }
  }, true);
  textures.grass.repeat.set(140, 140);

  textures.road = canvasTexture(64, 256, (ctx, w, h) => {
    ctx.fillStyle = '#3b3f45';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      const v = 50 + Math.random() * 24;
      ctx.fillStyle = `rgb(${v},${v + 2},${v + 6})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    }
  }, true);

  textures.boards = canvasTexture(1024, 64, (ctx, w, h) => {
    const panels = [
      { bg: '#1d2a6b', fg: '#ffffff' },
      { bg: '#ffffff', fg: '#7c3aed' },
      { bg: '#7c3aed', fg: '#ffffff' },
      { bg: '#111418', fg: '#ffd23f' },
    ];
    panels.forEach((p, i) => {
      ctx.fillStyle = p.bg;
      ctx.fillRect((i * w) / 4, 0, w / 4, h);
      ctx.fillStyle = p.fg;
      ctx.font = 'italic 900 38px "Big Shoulders Display", "Arial Narrow", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(i % 2 ? 'FASTEST LAP' : 'GHOST LAP', (i + 0.5) * (w / 4), h / 2 + 2);
    });
  }, true);

  textures.crowd = canvasTexture(256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#2b3038';
    ctx.fillRect(0, 0, w, h);
    const colours = ['#e8e8e8', '#ff8000', '#e10600', '#27f4d2', '#3671c6', '#ffd23f', '#9aa3ad'];
    for (let row = 0; row < 16; row++) {
      ctx.fillStyle = '#20242b';
      ctx.fillRect(0, row * 8 + 6, w, 2);
      for (let x = 0; x < w; x += 4) {
        ctx.fillStyle = colours[(Math.random() * colours.length) | 0];
        ctx.fillRect(x + Math.random(), row * 8 + 1, 3, 4);
      }
    }
  }, true);

  textures.chequer = canvasTexture(128, 16, (ctx, w, h) => {
    const size = 8;
    for (let x = 0; x < w; x += size) {
      for (let y = 0; y < h; y += size) {
        ctx.fillStyle = (x / size + y / size) % 2 ? '#111' : '#f4f4f4';
        ctx.fillRect(x, y, size, size);
      }
    }
  });

  textures.gantry = canvasTexture(512, 64, (ctx, w, h) => {
    ctx.fillStyle = '#14181e';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#7c3aed';
    ctx.beginPath();
    ctx.moveTo(18, h - 10);
    ctx.lineTo(48, 10);
    ctx.lineTo(70, 10);
    ctx.lineTo(40, h - 10);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'italic 900 40px "Big Shoulders Display", "Arial Narrow", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('GHOST LAP', 86, h / 2 + 2);
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = '#3a0a0a';
      ctx.beginPath();
      ctx.arc(330 + i * 34, h / 2, 11, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  textures.sky = canvasTexture(4, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#3f78c4');
    g.addColorStop(0.55, '#8dbbe6');
    g.addColorStop(1, '#d6e6f2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
  return textures;
}

function buildCircuit(samples) {
  const tex = getTextures();
  const group = new THREE.Group();
  const half = ROAD_WIDTH / 2;

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(9000, 9000),
    new THREE.MeshLambertMaterial({ map: tex.grass })
  );
  ground.rotation.x = -Math.PI / 2;
  group.add(ground);

  group.add(new THREE.Mesh(
    bandGeometry(samples, half, -half, 0.02, 30),
    new THREE.MeshLambertMaterial({ map: tex.road })
  ));

  const lineMat = new THREE.MeshBasicMaterial({ color: '#f2f2f2' });
  group.add(new THREE.Mesh(bandGeometry(samples, half - 0.15, half - 0.45, 0.03, 10), lineMat));
  group.add(new THREE.Mesh(bandGeometry(samples, -half + 0.45, -half + 0.15, 0.03, 10), lineMat));

  // Track points to test clearance against, so scenery never sits on the road.
  const probe = samples.filter((_, i) => i % 3 === 0);
  const clearance = (x, z) => {
    let best = Infinity;
    for (const p of probe) best = Math.min(best, (p.x - x) ** 2 + (p.z - z) ** 2);
    return Math.sqrt(best);
  };

  // Red and white kerbs on the corners.
  const kerbPos = [];
  const kerbCol = [];
  const red = new THREE.Color('#d81e1e');
  const white = new THREE.Color('#f4f4f4');
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    if (samples[i].curv < KERB_CURVATURE) continue;
    const a = samples[i];
    const b = samples[(i + 1) % n];
    const colour = i % 2 ? red : white;
    for (const side of [1, -1]) {
      const o1 = side * half;
      const o2 = side * (half + 1.3);
      const quad = [
        [a.x + a.nx * o1, a.z + a.nz * o1], [b.x + b.nx * o1, b.z + b.nz * o1], [a.x + a.nx * o2, a.z + a.nz * o2],
        [a.x + a.nx * o2, a.z + a.nz * o2], [b.x + b.nx * o1, b.z + b.nz * o1], [b.x + b.nx * o2, b.z + b.nz * o2],
      ];
      for (const [x, z] of quad) {
        kerbPos.push(x, 0.04, z);
        kerbCol.push(colour.r, colour.g, colour.b);
      }
    }
  }
  if (kerbPos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(kerbPos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(kerbCol, 3));
    group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  }

  // Advertising boards along both sides, skipped where they'd cut across track.
  const boardPos = [];
  const boardUv = [];
  const boardOffset = half + 7;
  for (const side of [1, -1]) {
    for (let i = 0; i < n; i++) {
      const a = samples[i];
      const b = samples[(i + 1) % n];
      const ax = a.x + a.nx * boardOffset * side;
      const az = a.z + a.nz * boardOffset * side;
      const bx = b.x + b.nx * boardOffset * side;
      const bz = b.z + b.nz * boardOffset * side;
      if (clearance(ax, az) < boardOffset - 1.5 || clearance(bx, bz) < boardOffset - 1.5) continue;
      // Flip the texture on one side so the text reads correctly from the track.
      const u1 = (side > 0 ? -a.d : a.d) / 40;
      const u2 = u1 + (side > 0 ? -STEP : STEP) / 40;
      boardPos.push(ax, 0, az, bx, 0, bz, ax, 1.1, az, ax, 1.1, az, bx, 0, bz, bx, 1.1, bz);
      boardUv.push(u1, 0, u2, 0, u1, 1, u1, 1, u2, 0, u2, 1);
    }
  }
  const boards = new THREE.BufferGeometry();
  boards.setAttribute('position', new THREE.Float32BufferAttribute(boardPos, 3));
  boards.setAttribute('uv', new THREE.Float32BufferAttribute(boardUv, 2));
  group.add(new THREE.Mesh(boards, new THREE.MeshBasicMaterial({ map: tex.boards, side: THREE.DoubleSide })));

  // Grandstands.
  const standMat = new THREE.MeshLambertMaterial({ map: tex.crowd });
  const roofMat = new THREE.MeshLambertMaterial({ color: '#d9dde2' });
  let lastStand = -Infinity;
  for (let i = 0; i < n; i += 8) {
    const p = samples[i];
    if (p.d - lastStand < 280) continue;
    const side = (i / 8) % 2 ? 1 : -1;
    const off = 34 * side;
    const x = p.x + p.nx * off;
    const z = p.z + p.nz * off;
    if (clearance(x, z) < 30) continue;
    lastStand = p.d;
    const stand = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(56, 11, 14), standMat);
    body.position.y = 5.5;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(60, 0.8, 18), roofMat);
    roof.position.y = 15;
    const pillar = new THREE.BoxGeometry(0.6, 15, 0.6);
    for (const px of [-28, 0, 28]) {
      const m = new THREE.Mesh(pillar, roofMat);
      m.position.set(px, 7.5, -6.5 * side);
      stand.add(m);
    }
    stand.add(body, roof);
    stand.position.set(x, 0, z);
    stand.rotation.y = Math.atan2(-p.tz, p.tx);
    group.add(stand);
  }

  // Trees, scattered away from the track.
  const xs = samples.map((p) => p.x);
  const zs = samples.map((p) => p.z);
  const bounds = { minX: Math.min(...xs) - 250, maxX: Math.max(...xs) + 250, minZ: Math.min(...zs) - 250, maxZ: Math.max(...zs) + 250 };
  const treeSpots = [];
  for (let tries = 0; tries < 2400 && treeSpots.length < 650; tries++) {
    const x = bounds.minX + Math.random() * (bounds.maxX - bounds.minX);
    const z = bounds.minZ + Math.random() * (bounds.maxZ - bounds.minZ);
    if (clearance(x, z) > 24) treeSpots.push({ x, z, s: 0.7 + Math.random() * 0.8 });
  }
  const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(3.2, 9, 7), new THREE.MeshLambertMaterial({ color: '#2f6b35' }), treeSpots.length);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.4, 0.5, 3, 6), new THREE.MeshLambertMaterial({ color: '#5a4030' }), treeSpots.length);
  const m = new THREE.Matrix4();
  const tint = new THREE.Color();
  treeSpots.forEach((t, i) => {
    m.makeScale(t.s, t.s, t.s).setPosition(t.x, 7.2 * t.s, t.z);
    crowns.setMatrixAt(i, m);
    crowns.setColorAt(i, tint.setHSL(0.3 + Math.random() * 0.06, 0.45, 0.24 + Math.random() * 0.1));
    m.makeScale(t.s, t.s, t.s).setPosition(t.x, 1.5 * t.s, t.z);
    trunks.setMatrixAt(i, m);
  });
  group.add(crowns, trunks);

  // Start/finish line and gantry.
  const start = samples[0];
  const heading = Math.atan2(-start.tz, start.tx);
  const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_WIDTH, 1.6), new THREE.MeshBasicMaterial({ map: tex.chequer }));
  line.rotation.x = -Math.PI / 2;
  line.rotation.z = heading + Math.PI / 2;
  line.position.set(start.x, 0.05, start.z);
  group.add(line);

  const gantry = new THREE.Group();
  const postGeo = new THREE.BoxGeometry(0.7, 8, 0.7);
  const postMat = new THREE.MeshLambertMaterial({ color: '#2a2f37' });
  for (const s of [1, -1]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(0, 4, s * (half + 2));
    gantry.add(post);
  }
  // The gantry's local x axis runs along the track, so the faces drivers see are +x and -x.
  const signMat = new THREE.MeshBasicMaterial({ map: tex.gantry });
  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 2, ROAD_WIDTH + 4.7),
    [signMat, signMat, postMat, postMat, postMat, postMat]
  );
  sign.position.y = 7.5;
  gantry.add(sign);
  gantry.position.set(start.x, 0, start.z);
  gantry.rotation.y = heading;
  group.add(gantry);

  return group;
}

// ---------- Cars ----------

function buildCar(colour, acronym) {
  const group = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color: colour });
  const dark = new THREE.MeshLambertMaterial({ color: '#1b1e23' });
  const tyre = new THREE.MeshLambertMaterial({ color: '#111214' });
  const mats = [body, dark, tyre];

  const box = (w, h, l, mat, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  box(0.9, 0.42, 3.3, body, 0, 0.32, 0.4); // tub
  box(0.38, 0.24, 1.7, body, 0, 0.3, -2.1); // nose
  box(1.9, 0.06, 0.55, dark, 0, 0.1, -2.75); // front wing
  box(0.05, 0.28, 0.6, body, 0.95, 0.2, -2.75);
  box(0.05, 0.28, 0.6, body, -0.95, 0.2, -2.75);
  box(1.6, 0.48, 1.6, body, 0, 0.3, 0.7); // sidepods
  box(0.5, 0.52, 1.6, body, 0, 0.72, 1.05); // engine cover
  box(1.0, 0.3, 0.36, dark, 0, 0.92, 2.35); // rear wing
  box(0.05, 0.75, 0.6, body, 0.52, 0.65, 2.3);
  box(0.05, 0.75, 0.6, body, -0.52, 0.65, 2.3);

  const wheels = [];
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.38, 18);
  wheelGeo.rotateZ(Math.PI / 2);
  for (const [x, z] of [[0.82, -1.75], [-0.82, -1.75], [0.8, 1.55], [-0.8, 1.55]]) {
    const w = new THREE.Mesh(wheelGeo, tyre);
    w.position.set(x, 0.36, z);
    group.add(w);
    wheels.push(w);
  }

  // Halo: the safety hoop around the cockpit, the most recognisable thing onboard.
  const haloCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.42, 0.68, 0.55),
    new THREE.Vector3(-0.4, 1.1, 0.0),
    new THREE.Vector3(0, 1.2, -0.36),
    new THREE.Vector3(0.4, 1.1, 0.0),
    new THREE.Vector3(0.42, 0.68, 0.55),
  ]);
  group.add(new THREE.Mesh(new THREE.TubeGeometry(haloCurve, 40, 0.032, 8), dark));
  const pillar = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.52, -0.95), new THREE.Vector3(0, 0.92, -0.62), new THREE.Vector3(0, 1.2, -0.36)]);
  group.add(new THREE.Mesh(new THREE.TubeGeometry(pillar, 12, 0.03, 8), dark));

  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), new THREE.MeshLambertMaterial({ color: '#f2f2f2' }));
  helmet.position.set(0, 0.86, 0.2);
  group.add(helmet);
  mats.push(helmet.material);

  // Steering wheel with shift lights, only really visible from the cockpit.
  const wheel = new THREE.Group();
  wheel.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.13, 0.04), dark));
  const leds = [];
  for (let i = 0; i < 10; i++) {
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.014, 0.01), new THREE.MeshBasicMaterial({ color: '#222' }));
    led.position.set(-0.1 + i * 0.022, 0.045, -0.025);
    wheel.add(led);
    leds.push(led);
  }
  wheel.position.set(0, 0.66, -0.33);
  wheel.rotation.x = -0.5;
  group.add(wheel);

  // Floating name tag, like the broadcast car trackers.
  const tagTex = canvasTexture(128, 48, (ctx, w, h) => {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.roundRect(4, 4, w - 8, h - 8, 6);
    ctx.fill();
    const v = parseInt(colour.slice(1), 16);
    const lum = 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
    ctx.fillStyle = lum > 150 ? '#14181e' : '#ffffff';
    ctx.font = '700 28px Barlow, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(acronym, w / 2, h / 2 + 1);
  });
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTex, depthTest: false, sizeAttenuation: false }));
  tag.scale.set(0.075, 0.028, 1);
  tag.position.y = 2.1;
  tag.renderOrder = 10;
  group.add(tag);

  return { group, mats, wheels, helmet, steering: wheel, leds, tag, heading: 0, spin: 0 };
}

function setGhost(car, ghost) {
  for (const m of car.mats) {
    m.transparent = ghost;
    m.opacity = ghost ? 0.42 : 1;
    m.depthWrite = !ghost;
    m.needsUpdate = true;
  }
  car.tag.visible = ghost;
  car.steering.visible = !ghost;
}

// ---------- The view ----------

export class OnboardView {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.className = 'onboard-canvas';
    container.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = getTextures().sky;
    this.scene.fog = new THREE.Fog('#c9dcec', 180, 1100);
    this.scene.add(new THREE.HemisphereLight('#dbeaff', '#4d6b3c', 1.6));
    const sun = new THREE.DirectionalLight('#fff4e0', 1.8);
    sun.position.set(300, 500, 200);
    this.scene.add(sun);

    this.camera = new THREE.PerspectiveCamera(64, 1, 0.05, 3000);
    this.cameraIndex = 0;
    this.viewIndex = 0;
    this.cars = [];
    this.drivers = [];
    this.lastT = null;

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
          <span class="hud-brand">Ghost Lap</span>
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
      </div>`;
    this.container.append(hud);

    const q = (s) => hud.querySelector(s);
    this.hud = {
      tower: q('.hud-tower'),
      laptime: q('.hud-laptime'),
      sectors: [...hud.querySelectorAll('[data-s]')],
      bar: q('.hud-driver-bar'),
      name: q('.hud-driver-name'),
      team: q('.hud-driver-team'),
      speed: q('.hud-speed b'),
      gear: q('.hud-gear b'),
      rpm: [...hud.querySelectorAll('.hud-rpm i')],
      throttle: q('.hud-throttle'),
      brake: q('.hud-brake'),
      driverGroup: q('.hud-switch .hud-group'),
      camButtons: [...hud.querySelectorAll('[data-cam]')],
    };
    this.hud.camButtons.forEach((b) => b.addEventListener('click', () => this.setCamera(Number(b.dataset.cam))));
  }

  setData({ drivers, sectorTimes }) {
    if (this.world) {
      this.scene.remove(this.world);
      disposeTree(this.world);
    }
    this.drivers = drivers;
    this.sectorTimes = sectorTimes;
    this.viewIndex = 0;
    this.lastT = null;

    const ref = drivers[0];
    const s = ref.metresPerUnit;
    const cx = ref.outline.reduce((a, p) => a + p.x, 0) / ref.outline.length;
    const cy = ref.outline.reduce((a, p) => a + p.y, 0) / ref.outline.length;
    this.toWorld = (p) => ({ x: (p.x - cx) * s, z: -(p.y - cy) * s });

    const { samples } = prepareCentreline(ref.outline.map(this.toWorld));
    this.world = new THREE.Group();
    this.world.add(buildCircuit(samples));
    this.cars = drivers.map((d) => {
      const car = buildCar(d.colour, d.acronym);
      this.world.add(car.group);
      return car;
    });
    this.scene.add(this.world);

    this.hud.driverGroup.innerHTML = drivers
      .map((d, i) => `<button type="button" data-view="${i}" aria-pressed="${i === 0}" style="--c:${d.colour}">${d.acronym}</button>`)
      .join('');
    this.hud.driverGroup.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => this.setDriver(Number(b.dataset.view)))
    );
    this.setDriver(0);
    this.setCamera(this.cameraIndex);
  }

  setDriver(i) {
    if (!this.cars.length) return;
    this.viewIndex = (i + this.cars.length) % this.cars.length;
    this.cars.forEach((car, j) => setGhost(car, j !== this.viewIndex));
    this.cars[this.viewIndex].group.add(this.camera);
    this.hud.driverGroup.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-pressed', String(j === this.viewIndex)));
    const d = this.drivers[this.viewIndex];
    this.hud.bar.style.background = d.colour;
    this.hud.name.textContent = d.name;
    this.hud.team.textContent = d.team;
    this.setCamera(this.cameraIndex);
    this.onChange?.();
  }

  setCamera(i) {
    this.cameraIndex = (i + CAMERAS.length) % CAMERAS.length;
    const cam = CAMERAS[this.cameraIndex];
    this.camera.position.set(...cam.pos);
    this.camera.rotation.set(cam.pitch, 0, 0);
    this.applyFov();
    this.basePos = cam.pos;
    const own = this.cars[this.viewIndex];
    if (own) own.helmet.visible = cam.id !== 'cockpit';
    this.hud.camButtons.forEach((b, j) => b.setAttribute('aria-pressed', String(j === this.cameraIndex)));
    this.onChange?.();
  }

  // Tall phone screens get a wider angle so you can still see the track.
  applyFov() {
    const base = CAMERAS[this.cameraIndex].fov;
    const aspect = this.camera.aspect || 1.6;
    this.camera.fov = aspect < 1.2 ? Math.min(95, base * (1.2 / aspect) ** 0.6) : base;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyFov();
    this.container.classList.toggle('hud-compact', w < 700);
    if (this.lastT != null) this.draw(this.lastT, this.lastRows);
  }

  draw(t, rows) {
    if (!this.cars.length || !this.container.clientWidth) return;
    const jumped = this.lastT == null || Math.abs(t - this.lastT) > 400;
    const dt = jumped ? 0 : t - this.lastT;
    this.lastT = t;
    this.lastRows = rows;

    this.drivers.forEach((d, i) => {
      const car = this.cars[i];
      const ct = Math.min(t, d.duration);
      const p = this.toWorld(d.posAt(ct));
      const back = this.toWorld(d.posAt(Math.max(0, ct - 160)));
      const ahead = this.toWorld(d.posAt(Math.min(d.duration, ct + 160)));
      const target = Math.atan2(-(ahead.x - back.x), -(ahead.z - back.z));
      car.heading = jumped ? target : angleLerp(car.heading, target, 0.3);
      car.group.position.set(p.x, 0, p.z);
      car.group.rotation.y = car.heading;

      const state = d.carAt(ct);
      car.spin += ((state.speed / 3.6) * (dt / 1000)) / 0.36;
      car.wheels.forEach((w) => (w.rotation.x = -car.spin));

      if (i === this.viewIndex) {
        const rpmShare = Math.min(1, Math.max(0, (state.rpm - 9500) / 2700));
        car.leds.forEach((led, k) => {
          const on = k < Math.round(rpmShare * 10);
          led.material.color.set(on ? (k < 4 ? '#22e06b' : k < 8 ? '#ff3131' : '#4f7cff') : '#222');
        });
      }
    });

    // A little vibration at speed, like a real onboard.
    const own = this.drivers[this.viewIndex];
    const ownState = own.carAt(Math.min(t, own.duration));
    if (!reduceMotion && this.basePos) {
      const amount = (ownState.speed / 340) * (CAMERAS[this.cameraIndex].id === 'chase' ? 0.5 : 1);
      this.camera.position.y = this.basePos[1] + (Math.sin(t / 31) * 0.005 + Math.sin(t / 17) * 0.003) * amount;
    }

    this.updateHud(t, rows, own, ownState);
    this.renderer.render(this.scene, this.camera);
  }

  updateHud(t, rows, own, state) {
    const h = this.hud;
    h.tower.innerHTML = rows
      .map((r, i) => {
        const gap = r.finished ? formatLapTime(r.d.duration) : i === 0 ? 'Interval' : formatGap(r.gap);
        const viewing = r.d === own ? ' is-viewing' : '';
        return `<li class="${viewing}"><span class="p">${i + 1}</span><span class="c" style="background:${r.d.colour}"></span><span class="n">${r.d.acronym}</span><span class="g">${gap}</span></li>`;
      })
      .join('');

    const ct = Math.min(t, own.duration);
    h.laptime.textContent = formatLapTime(ct);
    h.laptime.classList.toggle('is-done', t >= own.duration);

    // Sector boxes: purple if it's the best of the three laps, yellow if not.
    let elapsed = 0;
    h.sectors.forEach((el, i) => {
      const s = own.sectors[i];
      const end = i === 2 ? own.duration : elapsed + (s ?? 0);
      const best = Math.min(...this.drivers.map((d) => d.sectors[i] ?? Infinity));
      if (s != null && ct >= end - 1) {
        el.textContent = formatSector(s);
        el.className = s <= best ? 'is-best' : 'is-slower';
      } else if (ct >= elapsed) {
        el.textContent = `S${i + 1}`;
        el.className = 'is-live';
      } else {
        el.textContent = `S${i + 1}`;
        el.className = '';
      }
      elapsed = end;
    });

    h.speed.textContent = Math.round(state.speed);
    h.gear.textContent = state.gear || 'N';
    const lit = Math.round(Math.min(1, Math.max(0, (state.rpm - 8000) / 4200)) * 15);
    h.rpm.forEach((el, i) => el.classList.toggle('on', i < lit));
    h.throttle.style.height = `${state.throttle}%`;
    h.brake.style.height = state.brake ? '100%' : '0%';
  }
}