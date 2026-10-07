// Official circuit layout from MultiViewer (the same data FastF1 uses):
// the track outline, corner numbers, and the rotation that matches the
// official F1 track map. Uses the same coordinates as OpenF1's position data.

const CACHE_PREFIX = 'ghostlap:circuit:v1:';

export async function getCircuitInfo(circuitKey, year) {
  if (circuitKey == null) return null;
  const path = `/api/v1/circuits/${circuitKey}/${year}`;
  try {
    const hit = localStorage.getItem(CACHE_PREFIX + path);
    if (hit) return JSON.parse(hit);
  } catch {
    // no storage, carry on
  }
  // Try the dev-server proxy first, then the API directly.
  for (const url of [`/mv${path}`, `https://api.multiviewer.app${path}`]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data?.x)) continue;
      try {
        localStorage.setItem(CACHE_PREFIX + path, JSON.stringify(data));
      } catch {
        // storage full, fine
      }
      return data;
    } catch {
      // try the next route
    }
  }
  return null;
}

// Turn the raw data into what the views need. The outline is only used if it
// lines up with where the cars actually drove; otherwise the views fall back
// to the cars' own path, so cars can never end up off the track.
export function prepareCircuit(info, ref) {
  if (!info) return null;
  const rotation = Number(info.rotation) || 0;
  const corners = (info.corners ?? []).map((c) => ({
    x: c.trackPosition?.x ?? 0,
    y: c.trackPosition?.y ?? 0,
    label: `${c.number ?? ''}${c.letter ?? ''}`,
    angle: Number(c.angle) || 0,
  }));

  let outline = null;
  const raw = (info.x ?? []).map((x, i) => ({ x, y: info.y[i] })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (raw.length > 50) {
    // How far, on average, is the cars' path from the official outline?
    const probe = ref.outline.filter((_, i) => i % 8 === 0);
    let total = 0;
    for (const p of probe) {
      let best = Infinity;
      for (const q of raw) best = Math.min(best, (p.x - q.x) ** 2 + (p.y - q.y) ** 2);
      total += Math.sqrt(best);
    }
    const meanMetres = (total / probe.length) * ref.metresPerUnit;
    if (meanMetres < 12) outline = densify(alignToLap(raw, ref), 2 / ref.metresPerUnit);
  }
  return { rotation, corners, outline };
}

// Start the outline at the start/finish line and run it in the driving direction.
function alignToLap(points, ref) {
  const start = ref.posAt(0);
  const ahead = ref.posAt(3000);
  const nearest = (p) => {
    let bi = 0;
    let bd = Infinity;
    points.forEach((q, i) => {
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d < bd) { bd = d; bi = i; }
    });
    return bi;
  };
  const s = nearest(start);
  let pts = [...points.slice(s), ...points.slice(0, s)];
  const a = nearest.call(null, ahead);
  // If the point 3 s into the lap is in the second half, the outline runs backwards.
  const posAhead = (a - s + points.length) % points.length;
  if (posAhead > points.length / 2) pts = [pts[0], ...pts.slice(1).reverse()];
  return pts;
}

// Add points so no two are more than `step` apart, keeping corners crisp
// when the views smooth the outline.
function densify(points, step) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const parts = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < parts; k++) out.push({ x: a.x + ((b.x - a.x) * k) / parts, y: a.y + ((b.y - a.y) * k) / parts });
  }
  return out;
}