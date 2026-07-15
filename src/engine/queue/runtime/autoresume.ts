export const AUTORESUME_DELAY_MS = 50;

export interface AutoresumeGuards {
  readonly isPending: () => boolean;
  readonly isRunning: () => boolean;
  readonly isBlocked: () => boolean;
}

export interface AutoresumeScheduler {
  readonly arm: () => void;
  readonly clear: () => void;
  readonly dispose: () => void;
}

export interface CreateAutoresumeSchedulerOptions {
  readonly guards: AutoresumeGuards;
  readonly onFire: () => void;
  readonly clearPending: () => void;
  readonly delayMs?: number;
}

export function createAutoresumeScheduler(
  options: CreateAutoresumeSchedulerOptions,
): AutoresumeScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const delay = options.delayMs ?? AUTORESUME_DELAY_MS;

  function clear(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function fire(): void {
    timer = null;
    if (!options.guards.isPending()) return;
    if (options.guards.isRunning()) return;
    if (options.guards.isBlocked()) return;
    options.clearPending();
    options.onFire();
  }

  function arm(): void {
    clear();
    timer = setTimeout(fire, delay);
    timer.unref?.();
  }

  return {
    arm,
    clear,
    dispose: clear,
  };
}
