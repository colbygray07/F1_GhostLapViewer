// Every track the site knows about. To add a track, copy an entry and change it.
// circuitShortName must match OpenF1's `circuit_short_name` for that circuit.
// years: every season to search. The site picks the three fastest drivers
// across all of them. OpenF1 has telemetry from 2023 onwards.
// rotation: degrees to rotate the map, or null to auto-fit it to the screen.
export const TRACKS = [
  {
    id: 'monza',
    name: 'Monza',
    fullName: 'Autodromo Nazionale Monza',
    event: 'Italian Grand Prix',
    years: [2023, 2024, 2025, 2026],
    circuitShortName: 'Monza',
    session: 'Qualifying',
    rotation: null,
  },
  {
    id: 'montreal',
    name: 'Circuit Gilles-Villeneuve',
    fullName: 'Circuit Gilles-Villeneuve',
    event: 'Canadian Grand Prix',
    years: [2023, 2024, 2025, 2026],
    circuitShortName: 'Montreal',
    countryName: 'Canada', // fallback if the short name doesn't match
    session: 'Qualifying',
    rotation: null,
  },
];