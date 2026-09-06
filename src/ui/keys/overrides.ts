import { isKeyAction, isKeyContext, type KeyAction, type KeyContext } from "@/ui/keys/actions.ts";
import { normalizeChord } from "@/ui/keys/chord.ts";
import { DEFAULT_BINDINGS } from "@/ui/keys/defaults.ts";
import { reservedKeyFor } from "@/ui/keys/reserved.ts";
import type { BindingTable, ContextBindings } from "@/ui/keys/types.ts";

/**
 * A user's binding file, folded onto the shipped table.
 *
 * Pure: this reads a parsed document and answers with the table to resolve
 * against plus everything it had to refuse. Reading the file, watching it and
 * telling the reader about the refusals belong to the surfaces that own those
 * jobs — none of which this needs to know about.
 */

/** One complaint about the file, in the words the reader needs to fix it. */
export interface OverrideProblem {
  /** Where in the document, phrased as the reader wrote it. */
  at: string;
  message: string;
}

export interface OverrideResult {
  table: BindingTable;
  /** Everything refused or warned about, in document order. */
  problems: readonly OverrideProblem[];
}

/**
 * What takes a key back rather than giving it a new job. The measured contract
 * says `undefined`, which is what a JS document writes; JSON has no such value,
 * so `null` means the same thing here and a document may use either.
 */
function unbinds(action: unknown): boolean {
  return action === undefined || action === null;
}

export function applyBindingOverrides(
  document: unknown,
  base: BindingTable = DEFAULT_BINDINGS,
): OverrideResult {
  const problems: OverrideProblem[] = [];
  const blocks = blocksOf(document, problems);
  if (blocks.length === 0) return { table: base, problems };

  // A context is copied once however many blocks name it, so two blocks editing
  // the same context layer rather than the second replacing the first.
  const edited = new Map<KeyContext, Record<string, KeyAction>>();
  for (const [index, block] of blocks.entries()) {
    const where = `bindings[${index}]`;
    const context = contextOf(block, where, problems);
    if (context === null) continue;
    const bindings = bindingsOf(block, where, problems);
    if (bindings === null) continue;
    const target = edited.get(context) ?? { ...base[context] };
    edited.set(context, target);
    for (const [chord, action] of Object.entries(bindings)) {
      applyOne({ chord, action, context, where, target, problems });
    }
  }

  const table = { ...base } as Record<KeyContext, ContextBindings>;
  for (const [context, bindings] of edited) table[context] = bindings;
  return { table, problems };
}

function applyOne(input: {
  chord: string;
  action: unknown;
  context: KeyContext;
  where: string;
  target: Record<string, KeyAction>;
  problems: OverrideProblem[];
}): void {
  const { chord, action, context, where, target, problems } = input;
  const at = `${where}.bindings["${chord}"]`;
  const normalized = normalizeChord(chord);
  if (normalized === null) {
    problems.push({ at, message: `"${chord}" is not a key combination` });
    return;
  }
  if (unbinds(action)) {
    delete target[normalized];
    return;
  }
  if (typeof action !== "string" || !isKeyAction(action)) {
    problems.push({ at, message: `"${String(action)}" is not an action` });
    return;
  }
  const reserved = reservedKeyFor(normalized);
  if (reserved !== null) {
    problems.push({ at, message: `${normalized} is reserved — ${reserved.reason}` });
    // A warning applies anyway: whether the terminal takes the key first is the
    // emulator's answer, not ours, so refusing would deny a binding that works.
    if (reserved.severity === "error") return;
  }
  const held = target[normalized];
  if (held !== undefined && held !== action) {
    problems.push({
      at,
      message: `${normalized} already performs ${held} in ${context}; the later binding wins`,
    });
  }
  target[normalized] = action;
}

function blocksOf(document: unknown, problems: OverrideProblem[]): readonly unknown[] {
  if (document === null || typeof document !== "object") {
    problems.push({ at: "(file)", message: "expected an object naming `bindings`" });
    return [];
  }
  const bindings = (document as { bindings?: unknown }).bindings;
  if (bindings === undefined) {
    problems.push({ at: "(file)", message: "no `bindings` array, so nothing was changed" });
    return [];
  }
  if (!Array.isArray(bindings)) {
    problems.push({ at: "bindings", message: "expected an array of blocks" });
    return [];
  }
  return bindings;
}

function contextOf(block: unknown, where: string, problems: OverrideProblem[]): KeyContext | null {
  if (block === null || typeof block !== "object") {
    problems.push({ at: where, message: "expected an object naming `context` and `bindings`" });
    return null;
  }
  const context = (block as { context?: unknown }).context;
  if (typeof context !== "string" || !isKeyContext(context)) {
    problems.push({ at: `${where}.context`, message: `"${String(context)}" is not a context` });
    return null;
  }
  return context;
}

function bindingsOf(
  block: unknown,
  where: string,
  problems: OverrideProblem[],
): Record<string, unknown> | null {
  const bindings = (block as { bindings?: unknown }).bindings;
  if (bindings === null || typeof bindings !== "object" || Array.isArray(bindings)) {
    problems.push({ at: `${where}.bindings`, message: "expected an object of chord to action" });
    return null;
  }
  return bindings as Record<string, unknown>;
}
