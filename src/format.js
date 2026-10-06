// 79327 -> "1:19.327"
export function formatLapTime(ms) {
  if (ms == null || Number.isNaN(ms)) return '–';
  const minutes = Math.floor(ms / 60000);
  const seconds = (ms % 60000) / 1000;
  return minutes ? `${minutes}:${seconds.toFixed(3).padStart(6, '0')}` : seconds.toFixed(3);
}

// 0.1234 -> "+0.123"
export function formatGap(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '–';
  const sign = seconds < 0 ? '−' : '+';
  return `${sign}${Math.abs(seconds).toFixed(3)}`;
}

export const formatSector = (ms) => (ms == null ? '–' : (ms / 1000).toFixed(3));