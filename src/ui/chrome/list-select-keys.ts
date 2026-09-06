import { clamp } from "@/kernel/std/math.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { lookupKey } from "@/ui/keys/resolver.ts";

/**
 * The list-navigation vocabulary every panel list answers to: arrows and j/k step,
 * ctrl+n/ctrl+p step, the page keys move a caller-sized page, home/end reach the
 * ends, and 1-9 jump to that visible row and take it.
 *
 * Which key does which of those is the binding table's answer, not this file's —
 * so rebinding `select:next` moves every list at once, and the footer hint that
 * names the key reads from the same place. What stays here is what a cursor move
 * MEANS: how far a page is, and that the ends clamp.
 *
 * Pure by contract — panels keep their own cursor and their own actions. This says
 * where the cursor lands and whether the key also chose the row; anything else is
 * answered with undefined so the panel falls through to its own keys.
 */

export interface ListSelectState {
  cursor: number;
  /** Rows currently listed; nothing answers for an empty list. */
  count: number;
  /** Rows a page key steps — the caller's visible row budget. Defaults to one. */
  pageSize?: number | undefined;
}

export interface ListSelectAction {
  cursor: number;
  /** Set when the key also took the row (the digit jumps and selects). */
  activate?: true;
}

export function listSelectKey(
  key: KeyEventData,
  state: ListSelectState,
): ListSelectAction | undefined {
  const { cursor, count } = state;
  if (count <= 0) return undefined;
  const last = count - 1;
  const page = Math.max(1, Math.floor(state.pageSize ?? 1));
  const at = (next: number): ListSelectAction => ({ cursor: clamp(next, 0, last) });

  // The chordless lookup: a list binds no multi-step chord, and consulting the
  // chord-aware resolver on every list key would spend a prefix armed elsewhere.
  const resolved = lookupKey({ key, contexts: ["select"] });
  if (resolved.kind !== "action") return undefined;
  switch (resolved.action) {
    case "select:next":
      return at(cursor + 1);
    case "select:previous":
      return at(cursor - 1);
    case "select:pageDown":
      return at(cursor + page);
    case "select:pageUp":
      return at(cursor - page);
    case "select:first":
      return at(0);
    case "select:last":
      return at(last);
    case "select:jumpToRow": {
      // The table knows which digit was pressed; only the caller knows how many
      // rows there are, so a digit past the end is not a selection.
      const row = (resolved.row ?? 0) - 1;
      return row >= 0 && row < count ? { cursor: row, activate: true } : undefined;
    }
    default:
      return undefined;
  }
}
