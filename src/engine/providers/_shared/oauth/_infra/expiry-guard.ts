const REFRESH_LEAD_MS = 60_000;

export interface ExpiringToken {
  accessToken: string;
  expiresAtEpochMs: number;
}

export function isExpired(token: ExpiringToken, now: number = Date.now()): boolean {
  return now + REFRESH_LEAD_MS >= token.expiresAtEpochMs;
}

export class ExpiryGuard<T extends ExpiringToken> {
  private inflight: Promise<T> | null = null;

  constructor(
    private current: T,
    private readonly refresh: () => Promise<T>,
  ) {}

  async get(now: number = Date.now()): Promise<T> {
    if (!isExpired(this.current, now)) return this.current;
    if (!this.inflight) {
      this.inflight = this.refresh().then((next) => {
        this.current = next;
        this.inflight = null;
        return next;
      });
    }
    return this.inflight;
  }

  peek(): T {
    return this.current;
  }

  reset(next: T): void {
    this.current = next;
    this.inflight = null;
  }
}
