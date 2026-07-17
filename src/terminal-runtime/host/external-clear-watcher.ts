import { clearInterval, setInterval } from "node:timers";

export const EXTERNAL_CLEAR_WATCH_INTERVAL_MS = 200;
export const EXTERNAL_CLEAR_QUERY_TIMEOUT_MS = 500;

type CursorPositionQuerier = {
  requestCursorPosition(timeoutMs: number): Promise<number | undefined>;
};

type Timer = ReturnType<typeof setInterval>;

type ExternalClearWatcherOptions = {
  querier: CursorPositionQuerier;
  getExpectedCursorRow: () => number | null;
  onScreenClear: () => void;
  intervalMs?: number;
  setInterval?: (callback: () => void, delay: number) => Timer;
  clearInterval?: (timer: Timer) => void;
};

export function didExternalScreenClear(
  expectedCursorRow: number | null,
  reportedCursorRow: number | undefined,
): boolean {
  return expectedCursorRow !== null && expectedCursorRow >= 1 && reportedCursorRow === 1;
}

export class ExternalClearWatcher {
  private interval: Timer | null = null;
  private probeInFlight = false;

  constructor(private readonly options: ExternalClearWatcherOptions) {}

  start(): void {
    if (this.interval !== null) return;
    const callback = () => {
      void this.probe();
    };
    const delay = this.options.intervalMs ?? EXTERNAL_CLEAR_WATCH_INTERVAL_MS;
    this.interval = this.options.setInterval?.(callback, delay) ?? setInterval(callback, delay);
  }

  stop(): void {
    if (this.interval === null) return;
    if (this.options.clearInterval) this.options.clearInterval(this.interval);
    else clearInterval(this.interval);
    this.interval = null;
  }

  async probe(): Promise<void> {
    if (this.interval === null || this.probeInFlight) return;

    const expectedCursorRow = this.options.getExpectedCursorRow();
    if (expectedCursorRow === null || expectedCursorRow < 1) return;

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
