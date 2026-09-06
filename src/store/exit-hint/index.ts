import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";

/** Which interrupt key armed the twice-to-exit ladder. */
export type ExitChord = "ctrl-c" | "ctrl-d";

/** Whether the "press the interrupt key again to exit" hint is currently showing. */
export interface ExitHintState {
  readonly armed: boolean;
  /** Which chord armed it, so the hint names the key the user actually pressed. */
  readonly chord: ExitChord;
}

const initial: ExitHintState = { armed: false, chord: "ctrl-c" };

export const exitHintStore: Store<ExitHintState> = makeStore<ExitHintState>(initial);

export function setExitHintArmed(armed: boolean, chord: ExitChord = "ctrl-c"): void {
  exitHintStore.setState((prev) =>
    prev.armed === armed && prev.chord === chord ? prev : { armed, chord },
  );
}
