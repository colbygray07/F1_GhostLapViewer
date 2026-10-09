import './style.css';
import { TRACKS } from './tracks.js';
import { getSession, getLaps, getDrivers, getLocation, getCarData } from './api.js';
import { parseDate, pickFastestLaps, buildDriverLap, markSharedColours, buildDeltaSeries } from './lapData.js';
import { TrackView } from './trackView.js';
import { LineChart, valueAt } from './chart.js';
import { formatLapTime, formatGap, formatSector } from './format.js';
import { RaceAudio } from './engineAudio.js';
import { getCircuitInfo, prepareCircuit } from './circuit.js';

const $ = (sel) => document.querySelector(sel);
const els = {
  select: $('#track-select'),
  name: $('#track-name'),
  sub: $('#track-sub'),
  status: $('#stage-status'),
  play: $('#play-btn'),
  restart: $('#restart-btn'),
  scrubber: $('#scrubber'),
  scrubMarks: $('#scrub-marks'),
  clock: $('#clock'),
  speeds: [...document.querySelectorAll('[data-speed]')],
  tower: $('#tower-list'),
  onboard: $('#onboard'),
  canvas: $('#track-canvas'),
  stage: document.querySelector('.stage'),
  viewButtons: [...document.querySelectorAll('[data-view-mode]')],
  fullscreen: $('#fullscreen-btn'),
  sound: $('#sound-btn'),
  speedReadout: $('#speed-readout'),
  deltaReadout: $('#delta-readout'),
  sectorTable: $('#sector-table'),
  statsTable: $('#stats-table'),
};

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  drivers: [],
  t: 0,
  maxDuration: 0,
  playing: false,
  speed: 1,
  loadId: 0,
  dirty: true,
  towerRows: new Map(),
  view: 'map',
};

// The 3D onboard view is loaded the first time someone opens it, so the
// map view doesn't have to download three.js.
let onboard = null;

const audio = new RaceAudio();

const trackView = new TrackView($('#track-canvas'));
const speedChart = new LineChart($('#speed-chart'), {
  formatTick: (v) => `${Math.round(v)}`,
  onHover: (x) => showReadout(els.speedReadout, speedChart, x, (v) => `${Math.round(v)} km/h`),
  onSeek: seekToProgress,
});
const deltaChart = new LineChart($('#delta-chart'), {
  formatTick: (v) => (Math.abs(v) < 1e-9 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`),
  onHover: (x) => showReadout(els.deltaReadout, deltaChart, x, (v) => `${formatGap(v)}s`),
  onSeek: seekToProgress,
  zeroLine: true,
});

// ---------- Navigation ----------

els.select.innerHTML = TRACKS.map(
  (t) => `<option value="${t.id}">${t.name}</option>`
).join('');

function currentTrack() {
  const id = location.hash.match(/^#\/([\w-]+)/)?.[1];
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}

els.select.addEventListener('change', () => {
  location.hash = `#/${els.select.value}`;
});

window.addEventListener('hashchange', () => {
  // Section links (#telemetry) shouldn't reload the track.
  if (location.hash.startsWith('#/')) load(currentTrack());
});

// ---------- Loading ----------

function showStatus(message, retry) {
  els.status.hidden = false;
  els.status.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = message;
  els.status.append(p);
  if (retry) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-text';
    btn.type = 'button';
    btn.textContent = 'Try again';
    btn.addEventListener('click', retry);
    els.status.append(btn);
  }
}

async function load(track) {
  const loadId = ++state.loadId;
  const stale = () => loadId !== state.loadId;
  setPlaying(false);
  els.select.value = track.id;
  els.name.textContent = track.name;
  els.sub.textContent = `The three fastest ${track.session.toLowerCase()} laps at the ${track.event} since ${track.years[0]}, raced against each other.`;
  document.title = `${track.name} | F1 Ghost Lap Viewer`;

  const progress = (what) => showStatus(`${what}…`);

  try {
    // Gather every session's laps, then keep each driver's single best lap.
    const candidates = [];
    const driversBySession = new Map();
    for (const year of track.years) {
      progress(`Finding ${year} ${track.session.toLowerCase()}`);
      const session = await getSession({ ...track, year });
      if (stale()) return;
      if (!session) continue; // that season hasn't happened yet, or has no data
      session.year ??= year;
      progress(`Loading ${year} lap times`);
      const laps = await getLaps(session.session_key);
      const drivers = await getDrivers(session.session_key);
      if (stale()) return;
      driversBySession.set(session.session_key, drivers);
      for (const lap of pickFastestLaps(laps, 30)) {
        const driver = drivers.find((d) => d.driver_number === lap.driver_number);
        candidates.push({ lap, session, driver });
      }
    }
    if (!candidates.length) {
      throw new Error(`OpenF1 has no ${track.session.toLowerCase()} data for ${track.name}. Check circuitShortName and years in tracks.js.`);
    }

    // Race numbers change between seasons, so match drivers by name.
    candidates.sort((a, b) => a.lap.lap_duration - b.lap.lap_duration);
    const chosen = [];
    const seen = new Set();
    for (const c of candidates) {
      const who = c.driver?.full_name ?? `#${c.lap.driver_number}`;
      if (seen.has(who)) continue;
      seen.add(who);
      chosen.push(c);
      if (chosen.length === 3) break;
    }
    if (chosen.length < 3) throw new Error('Fewer than three drivers have timed laps here.');

    const built = [];
    for (const [index, { lap, session, driver }] of chosen.entries()) {
      const who = driver?.name_acronym ?? `#${lap.driver_number}`;
      const start = parseDate(lap.date_start);
      const end = start + lap.lap_duration * 1000;
      // A little padding either side so the path covers the whole lap.
      progress(`Loading ${who}'s ${session.year} position data`);
      const locations = await getLocation(session.session_key, lap.driver_number, start - 2000, end + 2000);
      progress(`Loading ${who}'s ${session.year} car telemetry`);
      const carData = await getCarData(session.session_key, lap.driver_number, start - 2000, end + 2000);
      if (stale()) return;
      const d = buildDriverLap({ lap, driver, locations, carData, index });
      d.year = session.year;
      d.team = d.team ? `${d.team}, ${session.year}` : String(session.year);
      built.push(d);
    }

    // Line every car up on the fastest car's start/finish line.
    const startLine = built[0].posAt(0);
    built.slice(1).forEach((d) => d.alignStartTo(startLine));
    markSharedColours(built);
    progress('Loading the official circuit layout');
    const { session: refSession } = chosen[0];
    const circuit = prepareCircuit(await getCircuitInfo(refSession.circuit_key, refSession.year), built[0]);
    if (stale()) return;
    setup(track, built, circuit);
    els.status.hidden = true;
    if (!reduceMotion) setPlaying(true);
  } catch (err) {
    if (stale()) return;
    console.error(err);
    const offline = err instanceof TypeError;
    showStatus(
      offline ? "Couldn't reach OpenF1. Check your connection and try again." : err.message,
      () => load(track)
    );
  }
}

// ---------- Building the views ----------

function setup(track, drivers, circuit = null) {
  state.circuit = circuit;
  state.drivers = drivers;
  state.maxDuration = Math.max(...drivers.map((d) => d.duration));
  state.t = 0;

  const ref = drivers[0];
  const s1 = ref.sectors[0];
  const s2 = ref.sectors[1];
  const sectorTimes = s1 && s2 ? [s1, s1 + s2] : [];
  const sectorMarks = sectorTimes.map((t) => ref.progressAt(t));

  trackView.setData({ drivers, rotation: track.rotation, sectorTimes, circuit });
  state.sectorTimes = sectorTimes;
  onboard?.setData({ drivers, sectorTimes, circuit });

  els.scrubber.max = Math.round(state.maxDuration);
  els.scrubMarks.innerHTML = sectorTimes
    .map((t) => `<span style="left:${(t / state.maxDuration) * 100}%"></span>`)
    .join('');

  speedChart.setData({
    sectorMarks,
    series: drivers.map((d) => ({ colour: d.colour, dashed: d.ring, points: d.speedSeries })),
  });
  deltaChart.setData({
    sectorMarks,
    series: drivers.map((d) => ({ colour: d.colour, dashed: d.ring, points: buildDeltaSeries(d, ref) })),
  });
  els.speedReadout.innerHTML = '';
  els.deltaReadout.innerHTML = '';

  buildTower(drivers);
  buildSectorTable(drivers);
  buildStatsTable(drivers);
  state.dirty = true;
}

function swatch(d) {
  return `<span class="swatch${d.ring ? ' swatch-ring' : ''}" style="--c:${d.colour}"></span>`;
}

function buildTower(drivers) {
  els.tower.innerHTML = '';
  state.towerRows.clear();
  for (const d of drivers) {
    const li = document.createElement('li');
    li.className = 'tower-row';
    li.style.setProperty('--c', d.colour);
    li.innerHTML = `
      <span class="pos"></span>
      <span class="team-bar${d.ring ? ' team-bar-ring' : ''}"></span>
      <span class="who">
        <span class="who-name">${d.name}</span>
        <span class="who-team">${d.team}</span>
      </span>
      <span class="gap"></span>
      <span class="live">
        <span class="live-speed"><b class="speed-val">0</b> km/h</span>
        <span class="live-gear">Gear <b class="gear-val">–</b></span>
        <span class="pedal" aria-label="Throttle"><span class="pedal-fill throttle"></span></span>
        <span class="pedal" aria-label="Brake"><span class="pedal-fill brake"></span></span>
      </span>`;
    els.tower.append(li);
    state.towerRows.set(d, {
      li,
      pos: li.querySelector('.pos'),
      gap: li.querySelector('.gap'),
      speed: li.querySelector('.speed-val'),
      gear: li.querySelector('.gear-val'),
      throttle: li.querySelector('.throttle'),
      brake: li.querySelector('.brake'),
    });
  }
}

function buildSectorTable(drivers) {
  const ref = drivers[0];
  const cols = [0, 1, 2].map((i) => Math.min(...drivers.map((d) => d.sectors[i] ?? Infinity)));
  els.sectorTable.innerHTML = `
    <caption>Sector times</caption>
    <thead><tr>
      <th scope="col">Driver</th><th scope="col">Sector 1</th><th scope="col">Sector 2</th>
      <th scope="col">Sector 3</th><th scope="col">Lap</th><th scope="col">Gap</th>
    </tr></thead>
    <tbody>${drivers
      .map(
        (d) => `<tr>
          <th scope="row">${swatch(d)}${d.name}</th>
          ${d.sectors
            .map((s, i) => `<td class="${s != null && s === cols[i] ? 'best' : ''}">${formatSector(s)}</td>`)
            .join('')}
          <td class="${d === ref ? 'best' : ''}">${formatLapTime(d.duration)}</td>
          <td>${d === ref ? 'Fastest' : formatGap((d.duration - ref.duration) / 1000)}</td>
        </tr>`
      )
      .join('')}</tbody>`;
}

function buildStatsTable(drivers) {
  const rows = [
    { label: 'Top speed', key: 'topSpeed', fmt: (v) => `${Math.round(v)} km/h`, best: 'max' },
    { label: 'Speed trap', key: 'speedTrap', fmt: (v) => `${Math.round(v)} km/h`, best: 'max' },
    { label: 'Average speed', key: 'avgSpeed', fmt: (v) => `${v.toFixed(1)} km/h`, best: 'max' },
    { label: 'Full throttle', key: 'fullThrottle', fmt: (v) => `${v.toFixed(0)}% of the lap`, best: 'max' },
    { label: 'On the brakes', key: 'braking', fmt: (v) => `${v.toFixed(0)}% of the lap` },
    { label: 'Gear changes', key: 'gearChanges', fmt: (v) => `${v}` },
  ];
  els.statsTable.innerHTML = `
    <caption>Lap stats</caption>
    <thead><tr><th scope="col">Stat</th>${drivers
      .map((d) => `<th scope="col">${swatch(d)}${d.acronym}</th>`)
      .join('')}</tr></thead>
    <tbody>${rows
      .map((row) => {
        const vals = drivers.map((d) => d.stats[row.key]);
        const valid = vals.filter((v) => v != null);
        const top = row.best === 'max' && valid.length ? Math.max(...valid) : null;
        return `<tr><th scope="row">${row.label}</th>${vals
          .map((v) => `<td class="${top != null && v === top ? 'best' : ''}">${v == null ? '–' : row.fmt(v)}</td>`)
          .join('')}</tr>`;
      })
      .join('')}</tbody>`;
}

function showReadout(target, chart, x, fmt) {
  if (x == null || !state.drivers.length) {
    target.innerHTML = '';
    return;
  }
  target.innerHTML = state.drivers
    .map((d, i) => `<span>${swatch(d)}${d.acronym} ${fmt(valueAt(chart.series[i].points, x))}</span>`)
    .join('');
}

// ---------- Views ----------

async function setView(view) {
  state.view = view;
  els.viewButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.viewMode === view)));
  if (view === 'onboard' && !onboard) {
    const { OnboardView } = await import('./onboardView.js');
    onboard = new OnboardView(els.onboard);
    onboard.onChange = () => (state.dirty = true);
    if (state.drivers.length) onboard.setData({ drivers: state.drivers, sectorTimes: state.sectorTimes, circuit: state.circuit });
  }
  els.onboard.hidden = view !== 'onboard';
  els.canvas.hidden = view === 'onboard';
  state.dirty = true;
}

els.viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.viewMode)));

// ---------- Sound ----------

function setSound(on) {
  audio.setEnabled(on);
  els.sound.setAttribute('aria-pressed', String(on));
  els.sound.setAttribute('aria-label', on ? 'Mute sound' : 'Turn sound on');
}
els.sound.addEventListener('click', () => setSound(!audio.enabled));

// Browsers block sound until the first click or key press, so start it then.
const unlockAudio = () => audio.unlock();
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });

// Engine follows the car you're riding with; the nearest ghost is heard too.
function updateAudio() {
  if (!state.drivers.length) return;
  const own = state.drivers[onboard?.viewIndex ?? 0];
  const t = state.t;
  const ownDone = t >= own.duration;
  const ownProgress = own.progressAt(t);
  const lapMetres = ((own.stats.avgSpeed ?? 200) / 3.6) * (own.duration / 1000);
  let ghost = null;
  for (const d of state.drivers) {
    if (d === own || t >= d.duration) continue;
    const gapMetres = (d.progressAt(t) - ownProgress) * lapMetres;
    if (!ghost || Math.abs(gapMetres) < Math.abs(ghost.gapMetres)) ghost = { ...d.carAt(t), gapMetres };
  }
  audio.update({ playing: state.playing && !ownDone, own: ownDone ? null : own.carAt(t), ghost });
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else els.stage.requestFullscreen?.();
}
els.fullscreen.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  els.fullscreen.setAttribute('aria-label', document.fullscreenElement ? 'Exit full screen' : 'Full screen');
});

// ---------- Playback ----------

function setPlaying(playing) {
  if (playing && state.t >= state.maxDuration) state.t = 0;
  state.playing = playing && state.drivers.length > 0;
  els.play.classList.toggle('is-playing', state.playing);
  els.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  state.dirty = true;
}

function setTime(t) {
  state.t = Math.min(Math.max(t, 0), state.maxDuration);
  state.dirty = true;
}

function seekToProgress(p) {
  if (!state.drivers.length) return;
  setPlaying(false);
  setTime(state.drivers[0].timeAtProgress(p));
}

els.play.addEventListener('click', () => setPlaying(!state.playing));
els.restart.addEventListener('click', () => setTime(0));
els.scrubber.addEventListener('input', () => {
  setPlaying(false);
  setTime(Number(els.scrubber.value));
});
els.speeds.forEach((btn) =>
  btn.addEventListener('click', () => {
    state.speed = Number(btn.dataset.speed);
    els.speeds.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  })
);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, button')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    setPlaying(!state.playing);
  } else if (e.key === 'ArrowRight') {
    setTime(state.t + 1000);
  } else if (e.key === 'ArrowLeft') {
    setTime(state.t - 1000);
  } else if (e.key === 'v' || e.key === 'V') {
    setView(state.view === 'map' ? 'onboard' : 'map');
  } else if (e.key === 'f' || e.key === 'F') {
    toggleFullscreen();
  } else if (e.key === 'm' || e.key === 'M') {
    setSound(!audio.enabled);
  } else if (state.view === 'onboard' && onboard) {
    if (e.key === 'c' || e.key === 'C') onboard.setCamera(onboard.cameraIndex + 1);
    else if (e.key === 'l' || e.key === 'L') onboard.setRacingLine(!onboard.showLine);
    else if (['1', '2', '3'].includes(e.key)) onboard.setDriver(Number(e.key) - 1);
  }
});

// Who's ahead right now, and by how much?
function standings(t) {
  const rows = state.drivers.map((d) => {
    const finished = t >= d.duration;
    return { d, finished, progress: finished ? 1 : d.progressAt(t) };
  });
  rows.sort((a, b) => {
    if (a.finished && b.finished) return a.d.duration - b.d.duration;
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    return b.progress - a.progress;
  });
  const leader = rows[0];
  for (const r of rows) {
    if (r === leader) r.gap = null;
    else if (r.finished) r.gap = (r.d.duration - leader.d.duration) / 1000;
    else r.gap = (t - leader.d.timeAtProgress(r.progress)) / 1000;
  }
  return rows;
}

function render() {
  const t = state.t;
  const rows = standings(t);
  if (state.view === 'onboard' && onboard) onboard.draw(t, rows);
  else trackView.draw(t);
  els.scrubber.value = Math.round(t);
  els.clock.textContent = formatLapTime(t);

  rows.forEach((r, i) => {
    const row = state.towerRows.get(r.d);
    const car = r.d.carAt(Math.min(t, r.d.duration));
    row.li.style.order = i;
    row.li.classList.toggle('is-finished', r.finished);
    row.pos.textContent = i + 1;
    row.gap.textContent = r.finished
      ? formatLapTime(r.d.duration)
      : r.gap == null ? 'Leader' : formatGap(r.gap);
    row.speed.textContent = Math.round(car.speed);
    row.gear.textContent = car.gear || 'N';
    row.throttle.style.width = `${car.throttle}%`;
    row.brake.style.width = car.brake ? '100%' : '0%';
  });

  const markers = state.drivers.map((d) => (t >= d.duration ? null : d.progressAt(t)));
  speedChart.setMarkers(markers);
  deltaChart.setMarkers(markers);
}

let lastFrame = null;
function frame(now) {
  if (state.playing) {
    if (lastFrame != null) {
      state.t += (now - lastFrame) * state.speed;
      if (state.t >= state.maxDuration) {
        state.t = state.maxDuration;
        setPlaying(false);
      }
    }
    lastFrame = now;
    state.dirty = true;
  } else {
    lastFrame = null;
  }
  if (state.dirty && state.drivers.length) {
    render();
    state.dirty = false;
  }
  updateAudio();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
load(currentTrack());