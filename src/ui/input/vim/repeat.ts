import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";

/**
 * Dot-repeat: what a change recorded, and how it is typed again. A change is the
 * keys that made it, not a description of what it did, so replaying it is the mode
 * machine reading those keys once more.
 */

/**
 * What insert added, or null when the trailer cannot be trusted.
 *
 * A recording is only usable when insert grew the buffer forward from where it
 * opened and left everything else alone. Moving the caret inside insert, or
 * deleting back past the opening point, makes the typed text unrecoverable from a
 * before-and-after comparison — and a wrong trailer would have `.` type something
 * the reader never typed, which is worse than `.` replaying only the removal.
 */
export function insertedText(
  before: string,
  after: string,
  openedAt: number,
  caret: number,
): string | null {
  if (caret < openedAt) return null;
  const added = caret - openedAt;
  if (after.length !== before.length + added) return null;
  if (after.slice(0, openedAt) !== before.slice(0, openedAt)) return null;
  if (after.slice(caret) !== before.slice(openedAt)) return null;
  return after.slice(openedAt, caret);
}

/** The keys that made a change, plus whatever insert added before it ended. */
export interface VimChange {
  keys: string;
  insert: string;
}

/**
 * The buffer surface a replay needs: it types the recorded keys back through the
 * mode machine, so the only thing it touches directly is the insert trailer.
 */
export interface ReplayBuffer {
  getText(): string;
  getCaretOffset(): number;
  applyEdit(edit: { text: string; caret: number }): void;
}

/**
 * Types a recorded change again. Motions and objects re-resolve as they are
 * retyped, which is what makes `.` land on the next word rather than repeat the
 * last edit's offsets — and a visual command re-projects its shape for the same
 * reason, since its selection keys are part of the recording.
 *
 * A count given to `.` replaces the one the change was recorded with.
 */
export function replayChange(
  change: VimChange,
  count: number | null,
  typeKey: (key: KeyEventData) => void,
  buffer: ReplayBuffer,
): void {
  const keys = count === null ? change.keys : `${count}${withoutLeadingCount(change.keys)}`;
  for (const key of keys) typeKey(printableKey(key));
  if (change.insert.length === 0) return;
  const text = buffer.getText();
  const caret = buffer.getCaretOffset();
  buffer.applyEdit({
    text: text.slice(0, caret) + change.insert + text.slice(caret),
    caret: caret + change.insert.length,
  });
}

/** A recorded command without its leading count, so a new one can replace it. */
function withoutLeadingCount(keys: string): string {
  return keys.replace(/^[1-9][0-9]*/, "");
}

/** A recorded key as the event the mode machine reads. */
function printableKey(sequence: string): KeyEventData {
  return {
    kind: "key",
    fn: false,
    name: sequence,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence,
    raw: sequence,
    isPasted: false,
  };
}

/**
 * The bookkeeping dot-repeat needs: which keys the command being typed has used so
 * far, what the last completed change was, and — for a change that ends in insert —
 * the buffer as insert opened, so the trailer can be read back.
 *
 * Its own object because that is four pieces of state serving one purpose, and
 * because a replay has to be able to say "do not record me" without every writer
 * checking a flag.
 */
export class ChangeRecorder {
  private last: VimChange | undefined;
  private awaitingTrailer: { keys: string; text: string; caret: number } | undefined;
  private keys = "";
  private replaying = false;

  /** The change `.` would replay, or undefined before any. */
  lastChange(): VimChange | undefined {
    return this.last;
  }

  isReplaying(): boolean {
    return this.replaying;
  }

  /** Runs `body` with recording suppressed, so a replay cannot record itself. */
  replay<T>(body: () => T): T {
    this.replaying = true;
    try {
      return body();
    } finally {
      this.replaying = false;
    }
  }

  /**
   * Joins a key to the command being composed, starting a fresh one when nothing is
   * half-typed. Visual is one long command, so its selection keys join the same run.
   */
  track(typed: string, halfTyped: boolean): void {
    if (this.replaying) return;
    this.keys = halfTyped ? this.keys + typed : typed;
  }

  /**
   * Keeps the command that made a change. One ending in insert waits for its
   * trailer instead: the removal and the replacement replay as one atom.
   */
  commit(entersInsert: boolean, text: string, caret: number): void {
    if (this.replaying) return;
    if (!entersInsert) {
      this.last = { keys: this.keys, insert: "" };
      this.awaitingTrailer = undefined;
      return;
    }
    this.awaitingTrailer = { keys: this.keys, text, caret };
  }

  /**
   * Closes a change that ended in insert. A trailer that cannot be read back leaves
   * the change recorded without one, so `.` still replays the removal.
   */
  settleTrailer(text: string, caret: number): void {
    const awaiting = this.awaitingTrailer;
    this.awaitingTrailer = undefined;
    if (awaiting === undefined) return;
    const typed = insertedText(awaiting.text, text, awaiting.caret, caret);
    this.last = { keys: awaiting.keys, insert: typed ?? "" };
  }
}
