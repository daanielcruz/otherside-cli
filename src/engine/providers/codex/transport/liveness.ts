import { StreamSilenceError } from "@/kernel/std/stream/idle-timeout.ts";

// A quiet stream is ambiguous: the model may be thinking, or the socket may be
// dead (network change, dropped tunnel). The probe disambiguates them long
// before the frame deadline: after a short quiet window it pings the socket,
// and a missing pong proves transport death. A pong only proves the socket —
// model progress is still owned by the frame deadline.
export const LIVENESS_PROBE_QUIET_MS = 25_000;
export const LIVENESS_PONG_DEADLINE_MS = 10_000;

export interface SocketLivenessTransport {
  ping(): void;
}

export interface SocketLivenessProbe {
  /** An inbound application frame arrived; the socket is proven alive. */
  frameReceived(): void;
  /** The transport answered the probe; the socket is alive but quiet. */
  pongReceived(): void;
  dispose(): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

function detachTimer(handle: TimerHandle): void {
  // On Windows the runtime does not fire unref'd timers while no other ref'd
  // handle is active, which would silently disarm the probe mid-stream.
  if (process.platform === "win32") return;
  const detachable = handle as TimerHandle & { unref?: () => void };
  detachable.unref?.();
}

export function createSocketLivenessProbe(
  transport: SocketLivenessTransport,
  onDead: (err: StreamSilenceError) => void,
  timing?: { quietMs?: number; pongDeadlineMs?: number },
): SocketLivenessProbe {
  const quietMs = timing?.quietMs ?? LIVENESS_PROBE_QUIET_MS;
  const pongDeadlineMs = timing?.pongDeadlineMs ?? LIVENESS_PONG_DEADLINE_MS;
  let quietTimer: TimerHandle | null = null;
  let pongTimer: TimerHandle | null = null;
  let disposed = false;

  const clearTimers = (): void => {
    if (quietTimer !== null) clearTimeout(quietTimer);
    if (pongTimer !== null) clearTimeout(pongTimer);
    quietTimer = null;
    pongTimer = null;
  };

  const armQuiet = (): void => {
    clearTimers();
    if (disposed) return;
    quietTimer = setTimeout(sendProbe, quietMs);
    detachTimer(quietTimer);
  };

  const sendProbe = (): void => {
    quietTimer = null;
    if (disposed) return;
    try {
      transport.ping();
    } catch {
      // A ping that cannot be written is the same evidence as a missing pong.
      failDead();
      return;
    }
    pongTimer = setTimeout(failDead, pongDeadlineMs);
    detachTimer(pongTimer);
  };

  const failDead = (): void => {
    pongTimer = null;
    if (disposed) return;
    disposed = true;
    clearTimers();
    onDead(new StreamSilenceError(quietMs + pongDeadlineMs));
  };

  armQuiet();

  return {
    frameReceived: armQuiet,
    pongReceived: armQuiet,
    dispose: (): void => {
      disposed = true;
      clearTimers();
    },
  };
}
