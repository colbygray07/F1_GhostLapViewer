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
    .sort((a, b) => a.t - b.t);
  if (loc.length < 20) throw new Error(`OpenF1 has too little position data for ${acronym}'s lap.`);

  // Resample positions onto an even time grid and measure distance travelled.
  const n = Math.floor(duration / STEP_MS) + 2;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const dist = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = Math.min(i * STEP_MS, duration);
    while (j < loc.length - 2 && loc[j + 1].t < t) j++;
    // Catmull-Rom spline through the samples gives smooth curves through
    // corners instead of straight lines between data points.
    const p0 = loc[Math.max(j - 1, 0)];
    const a = loc[j];
    const b = loc[j + 1];
    const p3 = loc[Math.min(j + 2, loc.length - 1)];
    const k = b.t === a.t ? 0 : clamp((t - a.t) / (b.t - a.t), 0, 1);
    const k2 = k * k;
    const k3 = k2 * k;
    const spline = (v0, v1, v2, v3) =>
      0.5 * (2 * v1 + (v2 - v0) * k + (2 * v0 - 5 * v1 + 4 * v2 - v3) * k2 + (3 * v1 - v0 - 3 * v2 + v3) * k3);
    xs[i] = spline(p0.x, a.x, b.x, p3.x);
    ys[i] = spline(p0.y, a.y, b.y, p3.y);
    if (i > 0) dist[i] = dist[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  const total = dist[n - 1] || 1;
  const progress = Array.from(dist, (d) => d / total);

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

  const gridIndex = (t) => clamp(t, 0, duration) / STEP_MS;

  function posAt(t) {
    const f = gridIndex(t);
    const i = Math.min(Math.floor(f), n - 2);
    const k = f - i;
    return { x: xs[i] + (xs[i + 1] - xs[i]) * k, y: ys[i] + (ys[i + 1] - ys[i]) * k };
  }

  function progressAt(t) {
    const f = gridIndex(t);
    const i = Math.min(Math.floor(f), n - 2);
    return progress[i] + (progress[i + 1] - progress[i]) * (f - i);
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

  const inLap = car.filter((c) => c.t >= 0 && c.t <= duration);
  const share = (fn) => (inLap.length ? (inLap.filter(fn).length / inLap.length) * 100 : 0);
  let gearChanges = 0;
  for (let i = 1; i < inLap.length; i++) if (inLap[i].gear !== inLap[i - 1].gear) gearChanges++;

  // OpenF1 doesn't document its x/y units, so work out metres per unit from
  // the lap itself: average speed x lap time = real lap distance.
  const avgSpeed = inLap.length ? inLap.reduce((s, c) => s + c.speed, 0) / inLap.length : 0;
  const realMetres = (avgSpeed / 3.6) * (duration / 1000);
  const metresPerUnit = realMetres > 0 ? realMetres / total : 0.1;

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
    outline: Array.from({ length: n }, (_, i) => ({ x: xs[i], y: ys[i] })),
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