const THOUSAND = 1_000;
const MILLION = 1_000_000;
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;
const SECOND_MS = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;

export function formatTokens(value: number): string {
  if (value < THOUSAND) return String(value);
  if (value < MILLION) return `${(value / THOUSAND).toFixed(1)}k`;
  return `${(value / MILLION).toFixed(1)}M`;
}

export function formatBytes(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < SECOND_MS) return "0s";
  const totalSec = Math.round(ms / SECOND_MS);
  if (totalSec < SECONDS_PER_MINUTE) return `${totalSec}s`;
  let seconds = totalSec % SECONDS_PER_MINUTE;
  let minutes = Math.floor(totalSec / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  let hours = Math.floor(totalSec / SECONDS_PER_HOUR) % HOURS_PER_DAY;
  const days = Math.floor(totalSec / SECONDS_PER_DAY);
  if (seconds === SECONDS_PER_MINUTE) {
    seconds = 0;
    minutes += 1;
  }
  if (minutes === MINUTES_PER_HOUR) {
    minutes = 0;
    hours += 1;
  }
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
