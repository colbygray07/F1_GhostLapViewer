// Turns raw OpenF1 rows into "lap" objects the views can query by time.
// All times inside a lap are milliseconds since that lap started.

const STEP_MS = 50; // resolution of the resampled path
const FALLBACK_COLOURS = ['#E8E8E8', '#FFB000', '#4FC3F7'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// OpenF1 dates look like 2024-08-31T14:00:59.123000+00:00. Trim microseconds
// so every browser parses them the same way.
export function parseDate(str) {
  if (!str) return NaN;
  const m = str.match(/^(.*T\d\d:\d\d:\d\d)(\.\d+)?(.*)$/);
  if (!m) return Date.parse(str);
  const fraction = m[2] ? m[2].slice(0, 4) : '';
  return Date.parse(m[1] + fraction + (m[3] || 'Z'));
}

// Gaussian blur of a 1D array; sigma is in samples. Edges are clamped.
function gaussian(values, sigma) {
  const radius = Math.ceil(sigma * 3);
  const weights = Array.from({ length: radius * 2 + 1 }, (_, k) => Math.exp(-((k - radius) ** 2) / (2 * sigma * sigma)));
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let wsum = 0;
    for (let k = -radius; k <= radius; k++) {
      const w = weights[k + radius];
      sum += values[clamp(i + k, 0, values.length - 1)] * w;
      wsum += w;
    }
    out[i] = sum / wsum;
  }
  return out;
}

// Speed (km/h) at time t, linearly interpolated from the car data samples.
function rawSpeed(car, t) {
  if (t <= car[0].t) return car[0].speed;
  const last = car[car.length - 1];
  if (t >= last.t) return last.speed;
  let lo = 0;
  let hi = car.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (car[mid].t < t) lo = mid;
    else hi = mid;
  }
  const a = car[lo];
  const b = car[hi];
  return a.speed + ((b.speed - a.speed) * (t - a.t)) / (b.t - a.t || 1);
}

// Fastest lap per driver, then the top `count` of those.
export function pickFastestLaps(laps, count = 3) {
  const best = new Map();
  for (const lap of laps) {
    if (!lap.lap_duration || !lap.date_start || lap.is_pit_out_lap) continue;
    const current = best.get(lap.driver_number);
    if (!current || lap.lap_duration < current.lap_duration) best.set(lap.driver_number, lap);
  }
  return [...best.values()].sort((a, b) => a.lap_duration - b.lap_duration).slice(0, count);
}

export function buildDriverLap({ lap, driver, locations, carData, index }) {
  const t0 = parseDate(lap.date_start);
  const duration = lap.lap_duration * 1000;
  const acronym = driver?.name_acronym ?? `#${lap.driver_number}`;

  const loc = locations
    .map((p) => ({ t: parseDate(p.date) - t0, x: p.x, y: p.y }))
    .filter((p) => Number.isFinite(p.t) && !(p.x === 0 && p.y === 0))
    .sort((a, b) => a.t - b.t)
    .filter((p, i, arr) => i === 0 || p.t > arr[i - 1].t); // drop duplicate timestamps
  if (loc.length < 20) throw new Error(`OpenF1 has too little position data for ${acronym}'s lap.`);

  // Resample positions onto an even time grid. We sample a little before and
  // after the lap too, so the smoothing below has data at the lap's edges.
  const n = Math.floor(duration / STEP_MS) + 2;
  const PAD = 30;
  const rawX = new Float64Array(n + PAD * 2);
  const rawY = new Float64Array(n + PAD * 2);
  let j = 0;
  for (let i = 0; i < rawX.length; i++) {
    const t = (i - PAD) * STEP_MS;
    while (j < loc.length - 2 && loc[j + 1].t < t) j++;
    // Catmull-Rom spline through the samples gives curves through corners
    // instead of straight lines between data points.
    const p0 = loc[Math.max(j - 1, 0)];
    const a = loc[j];
    const b = loc[j + 1];
    const p3 = loc[Math.min(j + 2, loc.length - 1)];
    const k = b.t === a.t ? 0 : clamp((t - a.t) / (b.t - a.t), 0, 1);
    const k2 = k * k;
    const k3 = k2 * k;
    const spline = (v0, v1, v2, v3) =>
      0.5 * (2 * v1 + (v2 - v0) * k + (2 * v0 - 5 * v1 + 4 * v2 - v3) * k2 + (3 * v1 - v0 - 3 * v2 + v3) * k3);
    rawX[i] = spline(p0.x, a.x, b.x, p3.x);
    rawY[i] = spline(p0.y, a.y, b.y, p3.y);
  }

  // The raw positions are a bit noisy, which makes cars wobble. A Gaussian
  // blur over ~150 ms irons that out without cutting corners.
  const SIGMA = 3;
  const RADIUS = SIGMA * 3;
  const weights = Array.from({ length: RADIUS * 2 + 1 }, (_, k) => Math.exp(-((k - RADIUS) ** 2) / (2 * SIGMA * SIGMA)));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const dist = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, sw = 0;
    for (let k = -RADIUS; k <= RADIUS; k++) {
      const idx = clamp(i + PAD + k, 0, rawX.length - 1);
      const w = weights[k + RADIUS];
      sx += rawX[idx] * w;
      sy += rawY[idx] * w;
      sw += w;
    }
    xs[i] = sx / sw;
    ys[i] = sy / sw;
    if (i > 0) dist[i] = dist[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  const roughTotal = dist[n - 1] || 1;

  const car = carData
    .map((c) => ({
      t: parseDate(c.date) - t0,
      speed: c.speed ?? 0,
      gear: c.n_gear ?? 0,
      throttle: clamp(c.throttle ?? 0, 0, 100),
      brake: (c.brake ?? 0) > 0,
      rpm: c.rpm ?? 0,
    }))
    .filter((c) => Number.isFinite(c.t) && c.t >= -500 && c.t <= duration + 500)
    .sort((a, b) => a.t - b.t);
  const inLap = car.filter((c) => c.t >= 0 && c.t <= duration);

  // OpenF1 doesn't document its x/y units, so work out metres per unit from
  // the lap itself: average speed x lap time = real lap distance.
  const avgSpeed = inLap.length ? inLap.reduce((s, c) => s + c.speed, 0) / inLap.length : 0;
  const realMetres = (avgSpeed / 3.6) * (duration / 1000);
  const metresPerUnit = realMetres > 0 ? realMetres / roughTotal : 0.1;

  // ---- The line: where the car goes ----
  // Resample the path every metre, then smooth it by distance. Smoothing by
  // distance (not time) gives clean, consistent racing lines through corners.
  const stepU = 1 / metresPerUnit;
  const m = Math.max(2, Math.floor(roughTotal / stepU) + 1);
  const rx = new Float64Array(m);
  const ry = new Float64Array(m);
  for (let i = 0, jj = 0; i < m; i++) {
    const d = Math.min(i * stepU, roughTotal);
    while (jj < n - 2 && dist[jj + 1] < d) jj++;
    const k = (d - dist[jj]) / (dist[jj + 1] - dist[jj] || 1);
    rx[i] = xs[jj] + (xs[jj + 1] - xs[jj]) * k;
    ry[i] = ys[jj] + (ys[jj + 1] - ys[jj]) * k;
  }
  const px = gaussian(rx, 4);
  const py = gaussian(ry, 4);
  const pathCum = new Float64Array(m);
  for (let i = 1; i < m; i++) pathCum[i] = pathCum[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]);
  const pathLen = pathCum[m - 1] || 1;

  // ---- The timing: when the car gets there ----
  // The position timestamps are uneven, which made cars surge and stall.
  // Instead, integrate the speed trace (smooth and accurate) to get distance
  // travelled over time, then place the car that far along the line.
  const gridT = (k) => Math.min(k * STEP_MS, duration);
  let progress;
  if (inLap.length >= 10) {
    const v = new Float64Array(n);
    for (let k = 0; k < n; k++) v[k] = rawSpeed(car, gridT(k)) / 3.6;
    const vs = gaussian(v, 3);
    const travelled = new Float64Array(n);
    for (let k = 1; k < n; k++) travelled[k] = travelled[k - 1] + ((vs[k] + vs[k - 1]) / 2) * ((gridT(k) - gridT(k - 1)) / 1000);
    const D = travelled[n - 1] || 1;
    progress = Array.from(travelled, (d) => d / D);
  } else {
    progress = Array.from(dist, (d) => d / roughTotal);
  }

  const gridIndex = (t) => clamp(t, 0, duration) / STEP_MS;

  function progressAt(t) {
    const f = gridIndex(t);
    const i = Math.min(Math.floor(f), n - 2);
    return progress[i] + (progress[i + 1] - progress[i]) * (f - i);
  }

  function pointAtDistance(sUnits) {
    let lo = 0;
    let hi = m - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pathCum[mid] < sUnits) lo = mid;
      else hi = mid;
    }
    const k = (sUnits - pathCum[lo]) / (pathCum[hi] - pathCum[lo] || 1);
    return { x: px[lo] + (px[hi] - px[lo]) * k, y: py[lo] + (py[hi] - py[lo]) * k };
  }

  function posAt(t) {
    return pointAtDistance(progressAt(t) * pathLen);
  }

  function timeAtProgress(p) {
    p = clamp(p, 0, 1);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (progress[mid] < p) lo = mid;
      else hi = mid;
    }
    const span = progress[hi] - progress[lo];
    const k = span > 0 ? (p - progress[lo]) / span : 0;
    return Math.min((lo + k) * STEP_MS, duration);
  }

  function carAt(t) {
    if (!car.length) return { speed: 0, gear: 0, throttle: 0, brake: false, rpm: 0 };
    let lo = 0;
    let hi = car.length - 1;
    if (t <= car[0].t) return car[0];
    if (t >= car[hi].t) return car[hi];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (car[mid].t < t) lo = mid;
      else hi = mid;
    }
    const a = car[lo];
    const b = car[hi];
    const k = (t - a.t) / (b.t - a.t || 1);
    const near = k < 0.5 ? a : b;
    return {
      speed: a.speed + (b.speed - a.speed) * k,
      throttle: a.throttle + (b.throttle - a.throttle) * k,
      rpm: a.rpm + (b.rpm - a.rpm) * k,
      gear: near.gear,
      brake: near.brake,
    };
  }

  // Path behind the car, for drawing a fading trail.
  function trail(t, lengthMs) {
    const pts = [];
    const start = Math.max(0, t - lengthMs);
    for (let s = start; s < t; s += STEP_MS) pts.push(posAt(s));
    pts.push(posAt(t));
    return pts;
  }

  const share = (fn) => (inLap.length ? (inLap.filter(fn).length / inLap.length) * 100 : 0);
  let gearChanges = 0;
  for (let i = 1; i < inLap.length; i++) if (inLap[i].gear !== inLap[i - 1].gear) gearChanges++;


  return {
    index,
    metresPerUnit,
    driverNumber: lap.driver_number,
    acronym,
    name: driver?.full_name ?? acronym,
    team: driver?.team_name ?? '',
    colour: driver?.team_colour ? `#${driver.team_colour}` : FALLBACK_COLOURS[index % 3],
    ring: false, // set later if a teammate shares the colour
    lapNumber: lap.lap_number,
    duration,
    sectors: [lap.duration_sector_1, lap.duration_sector_2, lap.duration_sector_3].map((s) =>
      s ? s * 1000 : null
    ),
    stats: {
      topSpeed: inLap.length ? Math.max(...inLap.map((c) => c.speed)) : null,
      speedTrap: lap.st_speed ?? null,
      avgSpeed: inLap.length ? avgSpeed : null,
      fullThrottle: share((c) => c.throttle >= 98),
      braking: share((c) => c.brake),
      gearChanges,
    },
    outline: Array.from({ length: Math.ceil(m / 2) }, (_, i) => ({ x: px[i * 2], y: py[i * 2] })),
    posAt,
    progressAt,
    timeAtProgress,
    carAt,
    trail,
    speedSeries: inLap.map((c) => ({ x: progressAt(c.t), y: c.speed })),
  };
}

// Teammates share a team colour, so the slower one gets drawn as a ring
// and a dashed line to keep them apart.
export function markSharedColours(drivers) {
  const seen = new Set();
  for (const d of drivers) {
    const key = d.colour.toLowerCase();
    if (seen.has(key)) d.ring = true;
    seen.add(key);
  }
}

// Time gap to the reference lap at each point around the track, in seconds.
export function buildDeltaSeries(driver, reference, samples = 600) {
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const p = i / samples;
    pts.push({ x: p, y: (driver.timeAtProgress(p) - reference.timeAtProgress(p)) / 1000 });
  }
  return pts;
}