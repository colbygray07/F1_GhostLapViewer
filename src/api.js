// Small client for the OpenF1 API (https://openf1.org).
// Historical data is free; the free tier allows roughly 3 requests per second,
// so every request goes through a queue that spaces them out, and responses
// are cached in localStorage so reloading the page doesn't hit the API again.

const BASE_URL = 'https://api.openf1.org/v1';
const MIN_GAP_MS = 400;
const CACHE_PREFIX = 'ghostlap:v1:';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let queue = Promise.resolve();
let lastRequestAt = 0;

function schedule(task) {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return task();
  });
  queue = run.catch(() => {});
  return run;
}

// Keys can carry a comparison operator, e.g. { 'date>=': '2024-08-31T14:00:00' }
function buildUrl(endpoint, params) {
  const query = Object.entries(params)
    .map(([key, value]) => {
      const [, field, op] = key.match(/^(\w+)(>=|<=|>|<)?$/);
      return `${field}${op ?? '='}${encodeURIComponent(value)}`;
    })
    .join('&');
  return `${BASE_URL}/${endpoint}?${query}`;
}

function readCache(url) {
  try {
    const hit = localStorage.getItem(CACHE_PREFIX + url);
    return hit ? JSON.parse(hit) : null;
  } catch {
    return null;
  }
}

function writeCache(url, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + url, JSON.stringify(data));
  } catch {
    // Storage full or unavailable: the site still works, it just refetches.
  }
}

async function request(endpoint, params) {
  const url = buildUrl(endpoint, params);
  const cached = readCache(url);
  if (cached) return cached;

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await schedule(() => fetch(url));
    if (res.ok) {
      const data = await res.json();
      writeCache(url, data);
      return data;
    }
    if (res.status === 404) return []; // OpenF1 answers "no results" with a 404
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`OpenF1 returned ${res.status} for ${endpoint}.`);
  }
  throw new Error('OpenF1 is rate limiting requests right now. Wait a minute and try again.');
}

// OpenF1 expects UTC dates without a timezone suffix.
const toApiDate = (ms) => new Date(ms).toISOString().replace('Z', '');

export async function getSession(track) {
  let rows = await request('sessions', {
    year: track.year,
    circuit_short_name: track.circuitShortName,
    session_name: track.session,
  });
  // If the short name doesn't match OpenF1's, try the country instead
  // (fine for countries that host a single Grand Prix).
  if (!rows.length && track.countryName) {
    rows = await request('sessions', {
      year: track.year,
      country_name: track.countryName,
      session_name: track.session,
    });
  }
  return rows[0] ?? null;
}

export const getLaps = (sessionKey) => request('laps', { session_key: sessionKey });

export const getDrivers = (sessionKey) => request('drivers', { session_key: sessionKey });

export const getLocation = (sessionKey, driverNumber, from, to) =>
  request('location', {
    session_key: sessionKey,
    driver_number: driverNumber,
    'date>=': toApiDate(from),
    'date<=': toApiDate(to),
  });

export const getCarData = (sessionKey, driverNumber, from, to) =>
  request('car_data', {
    session_key: sessionKey,
    driver_number: driverNumber,
    'date>=': toApiDate(from),
    'date<=': toApiDate(to),
  });