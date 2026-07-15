export const RECOVERABLE_TTY_ERRNOS: ReadonlySet<string> = new Set(["EIO", "ENOTTY", "EBADF"]);

const ATLAS_COL_STRIDE = 32768;
const DEFAULT_MAX_TRACKED_ATLAS_KEYS = 131072;

let metricsActive = false;
let atlasResetEnabled = false;
const atlasKeys: Set<number> = new Set();
let atlasSaturated = false;
let maxTrackedAtlasKeysOverride: number | null = null;

type StylepoolRef = { size: number; overflowed: boolean };
let stylepool: StylepoolRef | null = null;

let renderGlyphCardinalityEmitted = false;
let atlasResetTelemetryEmitted = false;
const _renderInstrumentationLogged = false;
const _atlasResetTelemetryLogged = false;
const _renderGlyphSamplingDone = false;

let atlasResetCount = 0;
let atlasResetLastReason = "none";
let atlasResetLastAt = 0;

export function recordAtlasKey(col: number, row: number): void {
  if (col < 2) return;
  const cap = maxTrackedAtlasKeysOverride ?? DEFAULT_MAX_TRACKED_ATLAS_KEYS;
  if (atlasKeys.size >= cap) {
    atlasSaturated = true;
    return;
  }
  atlasKeys.add(col * ATLAS_COL_STRIDE + row);
}

export function setMetricsActive(active: boolean): void {
  metricsActive = active;
}

export function setAtlasResetEnabled(enabled: boolean): void {
  atlasResetEnabled = enabled;
}

export function recordAtlasReset(reason: string): void {
  atlasResetCount++;
  atlasResetLastReason = reason;
  atlasResetLastAt = performance.now();
}

export function getAtlasResetMetrics(): {
  count: number;
  lastReason: string;
  lastResetAt: number;
} {
  return {
    count: atlasResetCount,
    lastReason: atlasResetLastReason,
    lastResetAt: atlasResetLastAt,
  };
}

export function getAtlasMetrics(): { atlasKeys: number; saturated: boolean } {
  return { atlasKeys: atlasKeys.size, saturated: atlasSaturated };
}

export function resetAtlasKeys(): void {
  atlasKeys.clear();
  atlasSaturated = false;
}

export function setOverflow(ref: StylepoolRef | null): void {
  stylepool = ref;
}

export function getStylepoolSnapshot(): StylepoolRef | null {
  if (!stylepool) return null;
  return { size: stylepool.size, overflowed: stylepool.overflowed };
}

export function markRenderGlyphCardinalityEmitted(): boolean {
  if (renderGlyphCardinalityEmitted) return false;
  renderGlyphCardinalityEmitted = true;
  return true;
}

export function markAtlasResetTelemetryEmitted(): boolean {
  if (atlasResetTelemetryEmitted) return false;
  atlasResetTelemetryEmitted = true;
  return true;
}

export function setMaxTrackedAtlasKeys(max: number | null): void {
  maxTrackedAtlasKeysOverride = max;
}

export function isMetricsActive(): boolean {
  return metricsActive;
}

export function isAtlasResetEnabled(): boolean {
  return atlasResetEnabled;
}
