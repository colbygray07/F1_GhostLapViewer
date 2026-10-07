// Track geometry shared by the 2D map and the 3D view (no three.js needed).

export const HALF = 6.5; // half the road width, in metres
export const STEP = 3; // metres between track samples
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Closed loop of {x, z} points: smooth it, resample every STEP metres, and
// work out direction, sideways normal and curvature at each sample.
export function prepareCentreline(points) {
  // The lap path is already smoothed in lapData, so only a very light touch
  // here; more would round off tight corners like chicanes.
  const n0 = points.length;
  const pts = points.map((_, i) => {
    const a = points[(i - 1 + n0) % n0];
    const b = points[i];
    const c = points[(i + 1) % n0];
    return { x: (a.x + 2 * b.x + c.x) / 4, z: (a.z + 2 * b.z + c.z) / 4 };
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


// OpenF1 records exactly where each car drove, but no public source gives
// the track edges. So we place the edges around the real line using how F1
// drivers take corners: outside edge at turn-in, inside edge at the apex,
// outside edge again at the exit, using less of the track for gentle bends
// and cutting straight from apex to apex through chicanes.
export function deriveTrackCentre(line) {
  const n = line.length;
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
  const curv = blur(line.map((p) => p.turn), 3); // signed: >0 is a right-hander
  const THRESHOLD = 1 / 650; // bends tighter than a 650 m radius count as corners
  const room = HALF - 1.0; // the car's centre can get this close to an edge

  // Start scanning from the straightest point so no corner is split in two.
  let s0 = 0;
  curv.forEach((c, i) => { if (Math.abs(c) < Math.abs(curv[s0])) s0 = i; });
  const at = (i) => curv[(i + s0) % n];

  // Find corners: runs of samples bending the same way.
  const corners = [];
  for (let i = 0; i < n; i++) {
    const c = at(i);
    if (Math.abs(c) < THRESHOLD) continue;
    const sign = Math.sign(c);
    let end = i;
    let apex = i;
    let sweep = 0;
    while (end < n && Math.abs(at(end)) >= THRESHOLD && Math.sign(at(end)) === sign) {
      if (Math.abs(at(end)) > Math.abs(at(apex))) apex = end;
      sweep += Math.abs(at(end)) * STEP;
      end++;
    }
    if (sweep > 0.12) corners.push({ start: i, end: end - 1, apex, sign, sweep }); // ignore bends under ~7°
    i = end;
  }

  // Keyframes for how far the car sits from the centre (+ = right of centre).
  let keys = [];
  corners.forEach((c, ci) => {
    const use = room * clamp((c.sweep - 0.1) / 0.4, 0.15, 1); // gentle bends use less width
    keys.push({ i: c.start - 8, y: -c.sign * use, corner: ci, kind: 'in' });
    keys.push({ i: c.apex, y: c.sign * use, corner: ci, kind: 'apex' });
    keys.push({ i: c.end + 10, y: -c.sign * use, corner: ci, kind: 'out' });
  });
  // Corners close together: drop the exit of one and the entry of the next,
  // so the car flows straight from apex to apex (chicanes) or stays put.
  for (let k = 0; k < keys.length - 1; k++) {
    const a = keys[k];
    const b = keys[k + 1];
    if (a.kind === 'out' && b.kind === 'in' && b.i - a.i < 25) {
      if (Math.sign(a.y) === Math.sign(b.y)) {
        a.i = Math.round((a.i + b.i) / 2);
        a.y = Math.sign(a.y) * Math.max(Math.abs(a.y), Math.abs(b.y));
        b.drop = true;
      } else {
        a.drop = b.drop = true;
      }
    } else if (a.kind === 'out' && b.kind === 'in' && b.i <= a.i) {
      a.drop = b.drop = true;
    }
  }
  keys = keys.filter((k) => !k.drop).sort((a, b) => a.i - b.i);

  const offsets = new Array(n).fill(0);
  if (keys.length) {
    for (let i = 0; i < n; i++) {
      // Surrounding keyframes, wrapping around the lap.
      let next = keys.findIndex((k) => k.i >= i);
      let a;
      let b;
      if (next === -1) { a = keys[keys.length - 1]; b = { ...keys[0], i: keys[0].i + n }; }
      else if (next === 0) { a = { ...keys[keys.length - 1], i: keys[keys.length - 1].i - n }; b = keys[0]; }
      else { a = keys[next - 1]; b = keys[next]; }
      const f = b.i === a.i ? 0 : (i - a.i) / (b.i - a.i);
      const eased = (1 - Math.cos(Math.PI * clamp(f, 0, 1))) / 2; // smooth, like a steering input
      offsets[(i + s0) % n] = a.y + (b.y - a.y) * eased;
    }
  }

  return line.map((p, i) => ({ x: p.x - p.nx * offsets[i], z: p.z - p.nz * offsets[i] }));
}