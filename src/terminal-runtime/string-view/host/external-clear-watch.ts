export const EXTERNAL_CLEAR_WATCH_INTERVAL_MS = 200;
export const EXTERNAL_CLEAR_QUERY_TIMEOUT_MS = 500;

type Timer = ReturnType<typeof setInterval>;

export interface CursorPositionQuerier {
  /** Resolves the terminal-reported absolute cursor row (1-based), or undefined on timeout. */
  requestCursorPosition(timeoutMs: number): Promise<number | undefined>;
}

export interface ExternalClearWatchOptions {
  querier: CursorPositionQuerier;
  /** Absolute 1-based screen row the parked cursor should be on; null while unknown. */
  getExpectedCursorRow: () => number | null;
  onScreenClear: () => void;
  intervalMs?: number;
  setIntervalFn?: (callback: () => void, delay: number) => Timer;
  clearIntervalFn?: (timer: Timer) => void;
}

/**
 * A host-terminal reset (iTerm/Apple_Terminal Cmd+R) wipes the screen without
 * telling the app: the frame memory still believes in painted rows while the
 * terminal shows nothing and homes the cursor. The wipe is observable — the
 * parked cursor should sit below the top row, so a cursor-position report of
 * row 1 while a deeper row is expected means the screen was cleared under us.
 */
export function didExternalScreenClear(
  expectedCursorRow: number | null,
  reportedCursorRow: number | undefined,
): boolean {
  return expectedCursorRow !== null && expectedCursorRow >= 2 && reportedCursorRow === 1;
}

export class ExternalClearWatcher {
  private interval: Timer | null = null;
  private probeInFlight = false;

  constructor(private readonly options: ExternalClearWatchOptions) {}

  start(): void {
    if (this.interval !== null) return;
    const callback = (): void => {
      void this.probe();
    };
    const delay = this.options.intervalMs ?? EXTERNAL_CLEAR_WATCH_INTERVAL_MS;
    this.interval = this.options.setIntervalFn?.(callback, delay) ?? setInterval(callback, delay);
    if (this.options.setIntervalFn === undefined) {
      (this.interval as Timer & { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    if (this.interval === null) return;
    if (this.options.clearIntervalFn) this.options.clearIntervalFn(this.interval);
    else clearInterval(this.interval);
    this.interval = null;
  }

  async probe(): Promise<void> {
    if (this.interval === null || this.probeInFlight) return;
    const expectedCursorRow = this.options.getExpectedCursorRow();
    if (expectedCursorRow === null || expectedCursorRow < 2) return;
    this.probeInFlight = true;
    try {
      const reportedCursorRow = await this.options.querier.requestCursorPosition(
        EXTERNAL_CLEAR_QUERY_TIMEOUT_MS,
      );
      if (this.interval !== null && didExternalScreenClear(expectedCursorRow, reportedCursorRow)) {
        this.options.onScreenClear();
      }
    } finally {
      this.probeInFlight = false;
    }
  }
}

export function shouldWatchExternalClears(options: {
  stdoutIsTTY: boolean | undefined;
  termProgram: string | undefined;
  disabled: string | undefined;
}): boolean {
  if (!options.stdoutIsTTY || options.disabled === "1") return false;
  return options.termProgram === "iTerm.app" || options.termProgram === "Apple_Terminal";
}
