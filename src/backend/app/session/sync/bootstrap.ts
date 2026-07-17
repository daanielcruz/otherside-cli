export const MAX_BOOTSTRAP_FAILURES = 3;

let bootstrapFailures = 0;
let bootstrapSuspended = false;
let lastBootstrapFailureReason: string | null = null;

export function isRemoteSyncSuspended(): boolean {
  return bootstrapSuspended;
}

export function resumeRemoteSync(): void {
  bootstrapFailures = 0;
  bootstrapSuspended = false;
  lastBootstrapFailureReason = null;
}

export function getLastRemoteBootstrapFailure(): string | null {
  return lastBootstrapFailureReason;
}

export function recordBootstrapFailure(reason: string): void {
  bootstrapFailures += 1;
  lastBootstrapFailureReason = reason;
  if (bootstrapFailures >= MAX_BOOTSTRAP_FAILURES) {
    bootstrapSuspended = true;
  }
}

export function resetBootstrapFailures(): void {
  bootstrapFailures = 0;
}
