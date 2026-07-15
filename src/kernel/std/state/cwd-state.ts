let trackedCwd: string = process.cwd();

export function getTrackedCwd(): string {
  return trackedCwd;
}

export function setTrackedCwd(value: string): void {
  trackedCwd = value;
}
