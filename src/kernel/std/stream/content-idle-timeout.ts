import { StreamSilenceError } from "@/kernel/std/stream/idle-timeout.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";

// Anthropic's edge sends an `event: ping` SSE frame roughly every 25s to keep the
// connection alive while the model is still generating. Those pings feed the
// byte-level watchdog (idle-timeout.ts) but are dropped before translateResponse
// ever turns them into a ProviderEvent, so a server-side generation stall on an
// otherwise-live socket can re-arm the byte watchdog forever while producing zero
// parsed output. This wrapper watches the PARSED event stream instead: only
// events that represent real generation progress re-arm it, so a ping-fed
// silence still trips a deadline for the shared classifier to resolve.
const DEFAULT_CONTENT_IDLE_TIMEOUT_MS = 180_000;

// One coarse tick instead of a clearTimeout/setTimeout pair per event: text
// and thinking deltas can arrive tens of times a second per stream across
// several concurrent agents, so re-arming a per-event timer means hundreds of
// timer syscalls plus a Promise.race allocation every second on the main
// thread. A single interval that samples a plain timestamp is orders of
// magnitude cheaper; the tradeoff is that expiry detection can lag by up to
// one tick (default timeout + up to ~15s), which is fine for a multi-minute
// idle deadline.
const DEFAULT_CONTENT_IDLE_CHECK_INTERVAL_MS = 15_000;

// providerDefaultMs lets a provider raise its own content deadline above the
// generic default for turns whose reasoning phase legitimately emits no
// ProviderEvents for extended stretches (e.g. reasoning requested without a
// summary). This is only safe when that provider carries its own frame-level
// transport deadline, so a truly dead stream is still caught independently of
// this event-level watchdog.
export function getContentIdleTimeoutMs(providerDefaultMs?: number): number {
  const raw = process.env.OTHERSIDE_CONTENT_IDLE_TIMEOUT_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (
    providerDefaultMs !== undefined &&
    Number.isFinite(providerDefaultMs) &&
    providerDefaultMs > 0
  ) {
    return providerDefaultMs;
  }
  return DEFAULT_CONTENT_IDLE_TIMEOUT_MS;
}

// SoT for what counts as generation progress: every ProviderEvent kind that a
// translateResponse implementation actually yields for a live, generating
// message. Deliberately exhaustive over the union (rather than a denylist) so a
// newly added administrative kind does not silently start re-arming the deadline.
const CONTENT_PROGRESS_KINDS = [
  "message_start",
  "usage",
  "usage_limits",
  "text_delta",
  "thinking_delta",
  "thinking_signature",
  "tool_call_start",
  "tool_call_input_delta",
  "tool_call_complete",
  "message_stop",
] as const satisfies readonly ProviderEvent["kind"][];

const CONTENT_PROGRESS_KIND_SET: ReadonlySet<string> = new Set(CONTENT_PROGRESS_KINDS);

export function isContentProgressEvent(ev: ProviderEvent): boolean {
  return CONTENT_PROGRESS_KIND_SET.has(ev.kind);
}

/**
 * Wraps a parsed ProviderEvent iterable with an independent idle deadline that
 * only re-arms on semantic progress (see CONTENT_PROGRESS_KINDS). Throws
 * StreamSilenceError("content") on expiry. The shared classifier retries
 * without keepalive proof and fails terminally when keepalives prove liveness.
 *
 * checkIntervalMs is exposed only so tests can use a fast tick; production
 * call sites should leave it at the default.
 */
export interface ContentIdleTimeoutOptions {
  timeoutMs?: number;
  checkIntervalMs?: number;
  onTimeout?: (error: StreamSilenceError) => void;
}

export async function* wrapProviderEventsWithContentIdleTimeout(
  events: AsyncIterable<ProviderEvent>,
  options: ContentIdleTimeoutOptions = {},
): AsyncIterable<ProviderEvent> {
  const timeoutMs = options.timeoutMs ?? getContentIdleTimeoutMs();
  const checkIntervalMs =
    options.checkIntervalMs ?? Math.min(DEFAULT_CONTENT_IDLE_CHECK_INTERVAL_MS, timeoutMs);
  const it = events[Symbol.asyncIterator]();
  let waiting = false;
  let waitingSinceMs: number | null = null;
  let accumulatedIdleMs = 0;
  let deadlineExpired = false;
  let rejectDeadline: (reason?: unknown) => void = () => {};

  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  // Pre-attach a handler: the rejection can land while the generator is
  // suspended at `yield` (no race in flight), which would otherwise surface
  // as an unhandled rejection before the next pull attaches one.
  deadline.catch(() => {});

  const expireDeadline = (): void => {
    if (deadlineExpired) return;
    deadlineExpired = true;
    const error = new StreamSilenceError(timeoutMs, "content");
    rejectDeadline(error);
    try {
      options.onTimeout?.(error);
    } catch {}
  };

  const tick = setInterval(() => {
    const currentOutstanding = waiting && waitingSinceMs !== null ? Date.now() - waitingSinceMs : 0;
    if (accumulatedIdleMs + currentOutstanding >= timeoutMs) expireDeadline();
  }, checkIntervalMs);
  // The tick stays ref'd on purpose: with every other handle idle (upstream
  // parked on a never-settling promise), an unref'd interval stops firing on
  // Windows, so the deadline would never reject and the wrapper would hang
  // forever. clearInterval in the finally below prevents any leak.

  try {
    while (true) {
      waiting = true;
      waitingSinceMs = Date.now();
      let result: IteratorResult<ProviderEvent>;
      try {
        result = await Promise.race([it.next(), deadline]);
      } finally {
        waiting = false;
      }
      const upstreamWaitMs = Date.now() - (waitingSinceMs ?? Date.now());
      waitingSinceMs = null;

      if (result.done) return;
      if (isContentProgressEvent(result.value)) {
        accumulatedIdleMs = 0;
      } else {
        accumulatedIdleMs += upstreamWaitMs;
        if (accumulatedIdleMs >= timeoutMs) expireDeadline();
      }
      yield result.value;
    }
  } finally {
    clearInterval(tick);
    // Best-effort, non-blocking cancellation of the upstream iterator: a stalled
    // upstream generator may be parked on a promise that never settles, so its
    // own return() completion could never resolve either — awaiting it here
    // would hang the very error/completion we just decided to deliver.
    try {
      void it.return?.()?.catch(() => {});
    } catch {}
  }
}
