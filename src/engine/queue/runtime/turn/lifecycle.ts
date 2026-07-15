import type { MutableRefObject } from "react";

export type TurnKind = "compact" | "skill" | "turn";

export interface TurnLifecycleDeps {
  runningRef: MutableRefObject<boolean>;
  generatorActiveRef: MutableRefObject<boolean>;
  compactRunningRef: MutableRefObject<boolean>;
  turnStartedAtRef: MutableRefObject<number | null>;
  setBusy: (value: boolean) => void;
  setProgressStartedAt: (value: number | null) => void;
  setLiveOutputTokens: (value: number) => void;
}

export interface TurnLifecycle {
  beginTurn: (kind: TurnKind, opts: { startedAt: number }) => void;
  endTurn: (kind: TurnKind) => void;
}

export function createTurnLifecycle(deps: TurnLifecycleDeps): TurnLifecycle {
  const beginTurn: TurnLifecycle["beginTurn"] = (kind, { startedAt }) => {
    deps.runningRef.current = true;
    if (kind !== "turn") deps.generatorActiveRef.current = true;
    if (kind === "compact") deps.compactRunningRef.current = true;
    // Stamp for EVERY kind (not just "turn") — the cancellation grace timer
    // compares this against the started-at it captured at cancel time to tell
    // whether ITS clobber would land on work that began after the cancel (e.g. a
    // promoted compact). Not cleared in endTurn: it only ever needs to reflect
    // "when did the most recent beginTurn happen".
    deps.turnStartedAtRef.current = startedAt;
    deps.setProgressStartedAt(startedAt);
    deps.setBusy(true);
  };

  const endTurn: TurnLifecycle["endTurn"] = (kind) => {
    deps.setBusy(false);
    deps.setProgressStartedAt(null);
    // Reset on skill end too, not just main turns — otherwise a skill fork's
    // accumulated meter value lingers in the statusline until the next turn.
    // Compact has its own reset paths.
    if (kind !== "compact") deps.setLiveOutputTokens(0);
    deps.runningRef.current = false;
    if (kind !== "turn") deps.generatorActiveRef.current = false;
    if (kind === "compact") deps.compactRunningRef.current = false;
  };

  return { beginTurn, endTurn };
}
