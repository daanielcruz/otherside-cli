const SUSPEND_SIGNAL: NodeJS.Signals = "SIGTSTP";
const RESUME_SIGNAL: NodeJS.Signals = "SIGCONT";

export interface SuspendSignals {
  raise(signal: NodeJS.Signals): void;
  onceResumed(handler: () => void): void;
}

export interface SuspendHooks {
  /** Hands the terminal back to the shell: cooked input, restored modes. */
  readonly release: () => void;
  /** Retakes the terminal after the shell foregrounds the process again. */
  readonly reclaim: () => void;
}

export const processSuspendSignals: SuspendSignals = {
  raise: (signal) => {
    process.kill(process.pid, signal);
  },
  onceResumed: (handler) => {
    process.once(RESUME_SIGNAL, handler);
  },
};

/**
 * Stops the process the way a shell job-control suspend does. The resume handler is
 * installed before the terminal is released so a fast foreground cannot land between
 * the two, and the raise comes last so the shell only ever sees a cooked terminal.
 */
export function suspendToShell(
  hooks: SuspendHooks,
  signals: SuspendSignals = processSuspendSignals,
): void {
  signals.onceResumed(hooks.reclaim);
  hooks.release();
  signals.raise(SUSPEND_SIGNAL);
}
