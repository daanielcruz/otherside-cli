import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { CTRL_X_CHORD_WINDOW_MS } from "@/ui/input/ctrl-x-chord.ts";
import type { KeyContext } from "@/ui/keys/actions.ts";
import { activeBindings } from "@/ui/keys/binding-file.ts";
import { chordStepForKey } from "@/ui/keys/chord.ts";
import { ROW_JUMP_DIGITS } from "@/ui/keys/defaults.ts";
import type { BindingTable, KeyResolution } from "@/ui/keys/types.ts";

/**
 * Which action a key press performs, given where it was pressed.
 *
 * Contexts stack innermost-first and the first one holding the chord wins, so a
 * search box open over a list answers before the list does. A press that starts
 * a multi-step chord parks the prefix; the window it waits in is the session's
 * one chord law, shared with the prefix the prompt already arms.
 */

const NONE: KeyResolution = { kind: "none" };

interface PendingChord {
  prefix: string;
  armedAt: number;
}

let pending: PendingChord | null = null;

/** Whether a chord is waiting for its next step, expiring it if the window closed. */
function livePrefix(now: number): string | null {
  if (pending === null) return null;
  if (now - pending.armedAt > CTRL_X_CHORD_WINDOW_MS) {
    pending = null;
    return null;
  }
  return pending.prefix;
}

/** Drops any parked prefix — a surface closing mid-chord must not leave one armed. */
export function releasePendingChord(): void {
  pending = null;
}

export function pendingChordPrefix(now: number = Date.now()): string | null {
  return livePrefix(now);
}

function bindingFor(
  table: BindingTable,
  contexts: readonly KeyContext[],
  chord: string,
): KeyResolution | null {
  for (const context of contexts) {
    const action = table[context]?.[chord];
    if (action !== undefined) return { kind: "action", action, context };
  }
  return null;
}

/** Whether any listed context binds a chord that begins with this step. */
function opensChord(table: BindingTable, contexts: readonly KeyContext[], step: string): boolean {
  const prefix = `${step} `;
  return contexts.some((context) =>
    Object.keys(table[context] ?? {}).some((chord) => chord.startsWith(prefix)),
  );
}

function rowJump(
  table: BindingTable,
  contexts: readonly KeyContext[],
  step: string,
): KeyResolution | null {
  const digit = ROW_JUMP_DIGITS.indexOf(step);
  if (step.length !== 1 || digit < 0) return null;
  const context = contexts.find((name) => table[name]?.down === "select:next");
  if (context === undefined) return null;
  return { kind: "action", action: "select:jumpToRow", context, row: digit + 1 };
}

export interface ResolveKeyInput {
  key: KeyEventData;
  /** Innermost context first; the first one holding the chord answers. */
  contexts: readonly KeyContext[];
  table?: BindingTable;
  now?: number;
}

/**
 * The action a key press performs, ignoring multi-step chords entirely — and, just
 * as importantly, leaving any parked prefix alone.
 *
 * A surface whose contexts hold no chords has nothing to gain from the chord
 * machinery and something to lose to it: `resolveKey` spends a live prefix on
 * every press it sees, so a list consulting it on each key would eat the prefix
 * the prompt armed. This is the answer for those surfaces.
 */
export function lookupKey(input: ResolveKeyInput): KeyResolution {
  const { key, contexts } = input;
  const table = input.table ?? activeBindings();
  const step = chordStepForKey(key);
  if (step === null) return NONE;
  return bindingFor(table, contexts, step) ?? rowJump(table, contexts, step) ?? NONE;
}

export function resolveKey(input: ResolveKeyInput): KeyResolution {
  const { key, contexts } = input;
  const table = input.table ?? activeBindings();
  const now = input.now ?? Date.now();

  const step = chordStepForKey(key);
  if (step === null) {
    pending = null;
    return NONE;
  }

  // A parked prefix gets first refusal. When the continuation misses, the prefix
  // is spent rather than swallowing the key: an abandoned chord must still let
  // the press act on its own.
  const prefix = livePrefix(now);
  if (prefix !== null) {
    pending = null;
    const completed = bindingFor(table, contexts, `${prefix} ${step}`);
    if (completed !== null) return completed;
  }

  const direct = bindingFor(table, contexts, step);
  if (direct !== null) return direct;

  if (opensChord(table, contexts, step)) {
    pending = { prefix: step, armedAt: now };
    return { kind: "pending", prefix: step };
  }

  return rowJump(table, contexts, step) ?? NONE;
}
