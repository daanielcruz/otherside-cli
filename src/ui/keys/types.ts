import type { KeyAction, KeyContext } from "@/ui/keys/actions.ts";

/** One context's table: normalized chord to the single action it performs. */
export type ContextBindings = Readonly<Record<string, KeyAction>>;

/** Every context's table, which is what a user file layers over. */
export type BindingTable = Readonly<Record<KeyContext, ContextBindings>>;

/**
 * What a key press amounted to.
 *
 * `pending` means the press opened a chord and the next press decides — the
 * caller draws nothing and swallows the key. `none` means no context claimed it,
 * so the caller's own handling runs unchanged.
 */
export type KeyResolution =
  | {
      kind: "action";
      action: KeyAction;
      /** Which context in the stack claimed the press. */
      context: KeyContext;
      /** The 1-based row a digit jump chose; set only for `select:jumpToRow`. */
      row?: number;
    }
  | { kind: "pending"; prefix: string }
  | { kind: "none" };
