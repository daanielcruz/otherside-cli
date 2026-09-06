import type { TurnLoopHost } from "./types.ts";

// Per-host turn epoch: a dispatch can be cancelled from the UI (turnGuard.abort())
// while a turn generator is still parked inside a slow tool whose own abort handling
// has not resolved, leaving a "zombie" invocation suspended. The next
// dispatch calls runTurn() again for the SAME host and resets the shared
// `host.cancelled` flag for ITS OWN turn — which would also un-cancel the zombie's
// view of that flag, since it is one boolean shared across invocations. The epoch
// closes that: each invocation bumps it at start and captures its own value, so a
// zombie's cancellation checks stay true even after a newer turn resets
// `host.cancelled`, and its finally cannot flip shared turn-active state out from
// under the turn that superseded it.
const turnEpochByHost = new WeakMap<TurnLoopHost, number>();

export function beginTurnEpoch(host: TurnLoopHost): number {
  const epoch = (turnEpochByHost.get(host) ?? 0) + 1;
  turnEpochByHost.set(host, epoch);
  return epoch;
}

export function isSuperseded(host: TurnLoopHost, epoch: number): boolean {
  return turnEpochByHost.get(host) !== epoch;
}
