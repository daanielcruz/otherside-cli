export function flushEventTimestamp(): void {}
export function recordEventTimestamp(_immediate?: boolean): void {}
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
export function getAttacherCaps(): AttacherCaps | null {
  return null;
}
export function onAttacherCapsChange(_listener: () => void): () => void {
  return () => {};
}
