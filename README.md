# F1 Ghost Lap Viewer

Watch the three fastest F1 qualifying laps race each other around the track, built from real car telemetry.

F1 Ghost Lap Viewer pulls lap times, car positions and telemetry from the OpenF1 API, lines the three fastest laps up so they start together, and replays them on a track map. You can see exactly where one driver gains time on another, corner by corner.

## What it does

- Searches every qualifying session OpenF1 has for a track (2023 onwards) and picks the three fastest drivers, one lap each.
- Draws the circuit from the fastest car's actual position data, with sector markers and the start/finish line.
- Replays all three laps at once with play, pause, scrubbing and speeds from ¼× to 4×.
- Shows a live timing tower with position, gap, speed, gear, throttle and brake for each car.
- Plots speed and the time gap to the fastest lap against distance around the lap. Clicking a chart jumps the replay to that spot.
- Rides onboard in 3D with T-cam, cockpit and chase cameras and TV-style graphics, with the other two laps shown as ghost cars.
- Breaks down sector times and lap stats such as top speed, full-throttle percentage and gear changes.

## Run locally

Install Node.js, then from the project folder:

```
npm install
npm run dev
```

Open the local URL printed in the terminal. The first load fetches about nine requests from OpenF1 (spaced out to respect the free rate limit); after that, responses are cached in your browser.

## Add a track

Add an entry to `src/tracks.js`. `circuitShortName` must match OpenF1's `circuit_short_name`, and `year` should be 2023 or later, when OpenF1's position data is most complete.

## Built with

- JavaScript, HTML and CSS
- Vite
- Canvas 2D for the track map and charts
- Three.js for the 3D onboard view
- OpenF1 API

## How it works

- `src/api.js` fetches from OpenF1 through a throttled queue with retries and caching.
- `src/lapData.js` resamples each lap's positions onto an even time grid and measures distance travelled, so any lap can be queried by time or by how far around the track it is.
- `src/trackView.js` draws the circuit once to an offscreen canvas, then draws the cars and their trails each frame.
- `src/chart.js` is a small canvas line chart with hover and click-to-seek.
- `src/onboardView.js` builds the 3D circuit, cars and broadcast graphics for the onboard view.
- `src/main.js` loads the data, builds the views and runs the playback loop.

## Current limits

- OpenF1 telemetry starts in 2023, so older laps (like Hamilton's 2020 Monza pole) can't be replayed.
- Track edges are estimated from the drivers' lines, since OpenF1 doesn't provide circuit geometry.

- OpenF1 position and telemetry data is sampled at about 3.7 Hz, so positions between samples are interpolated.
- Lap start times and position timestamps don't always line up perfectly, so a car can appear slightly off the line at the very start.
- Laps deleted for track limits aren't flagged in the lap data, so a deleted lap could occasionally appear.

## Disclaimer

Lap data comes from the [OpenF1 API](https://openf1.org). F1 Ghost Lap Viewer is an unofficial fan project and isn't affiliated with Formula 1.

AI assistance: Claude was used to help write code and documentation.