/**
 * Auto-remint loop for the design pairing link. design_open_tokens live for
 * five minutes; while the web app has not attached yet, this schedules a
 * re-mint at each expiry so the URL shown in the overlay stays usable. The
 * backend mint endpoint only takes session_id, so the same session is
 * reused — no relay teardown. Remints are capped so an abandoned overlay does
 * not mint tokens forever.
 */

export const DESIGN_REMINT_CAP = 10;
const REMINT_RETRY_DELAY_MS = 15_000;

export interface MintedLink {
  url: string;
  expiresAt: string;
}

export interface TokenRefresherDeps {
  /** Mint a fresh open token for the SAME session and build its URL. */
  mint: () => Promise<MintedLink>;
  /** Once attached the pairing link is irrelevant — the loop stands down. */
  isAttached: () => boolean;
  /** Push the fresh link into the spawn registry (overlay swaps it live). */
  onUpdate: (url: string, expiresAt: string) => void;
  /** Remint cap exhausted — the link is permanently dead. */
  onExhausted: () => void;
  onError?: (err: unknown) => void;
  maxRemints?: number;
  retryDelayMs?: number;
}

export interface TokenRefresher {
  /** (Re)arm the timer to fire when the given ISO expiry passes. */
  schedule: (expiresAt: string) => void;
  stop: () => void;
  remintCount: () => number;
}

export function createTokenRefresher(deps: TokenRefresherDeps): TokenRefresher {
  const max = deps.maxRemints ?? DESIGN_REMINT_CAP;
  const retryDelayMs = deps.retryDelayMs ?? REMINT_RETRY_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let remints = 0;
  let stopped = false;

  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const arm = (delayMs: number): void => {
    clear();
    timer = setTimeout(
      () => {
        timer = null;
        void fire();
      },
      Math.max(0, delayMs),
    );
  };

  const fire = async (): Promise<void> => {
    if (stopped || deps.isAttached()) return;
    if (remints >= max) {
      deps.onExhausted();
      return;
    }
    remints += 1;
    try {
      const next = await deps.mint();
      if (stopped || deps.isAttached()) return;
      deps.onUpdate(next.url, next.expiresAt);
      arm(Date.parse(next.expiresAt) - Date.now());
    } catch (err) {
      deps.onError?.(err);
      if (stopped || deps.isAttached()) return;
      if (remints >= max) {
        deps.onExhausted();
        return;
      }
      arm(retryDelayMs);
    }
  };

  return {
    schedule(expiresAt: string): void {
      if (stopped) return;
      arm(Date.parse(expiresAt) - Date.now());
    },
    stop(): void {
      stopped = true;
      clear();
    },
    remintCount(): number {
      return remints;
    },
  };
}
