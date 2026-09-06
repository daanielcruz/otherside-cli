let pendingEventTimestamp: number | null = null;

export function flushEventTimestamp(): number | null {
  if (pendingEventTimestamp === null) return null;
  const elapsedMs = performance.now() - pendingEventTimestamp;
  pendingEventTimestamp = null;
  return elapsedMs;
}

export function recordEventTimestamp(immediate = false): void {
  if (pendingEventTimestamp === null || immediate) pendingEventTimestamp = performance.now();
}

export function recordScrollActivity(): void {}

const _launchDirectory: string = process.cwd();
export function getCurrentDirectory(): string {
  return process.cwd();
}
export function getLaunchDirectory(): string {
  return _launchDirectory;
}

export function recordSlowOperation(_description: string, _durationMs: number): void {}
export function getSessionIdentifier(): string {
  return "otherside-ink";
}
export function isTerminalInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export type AttacherCaps = {
  terminal?: string;
  mux?: "tmux" | "screen" | null;
  ssh?: boolean;
  isVscodeTerm?: boolean;
  hyperlinks?: boolean;
  wtSession?: boolean;
  syncOutput?: boolean;
  progressReporting?: boolean;
};
export function readAttacherCapabilities(): AttacherCaps | null {
  return null;
}
export function onAttacherCapabilitiesChange(_listener: () => void): () => void {
  return () => {};
}
