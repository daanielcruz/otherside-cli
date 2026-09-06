import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { DEFAULT_BINDINGS } from "@/ui/keys/defaults.ts";
import { applyBindingOverrides, type OverrideProblem } from "@/ui/keys/overrides.ts";
import type { BindingTable } from "@/ui/keys/types.ts";

/**
 * The user's binding file: where it lives, how it is read, and the template a
 * first edit starts from.
 *
 * The table it produces is held rather than re-read, because every key press
 * consults it and a config read on that path is disk I/O. A reload is asked for
 * explicitly — by the command that just wrote the file, or by whatever watches it.
 */

export function bindingFilePath(): string {
  return join(configRoot(), "keybindings.json");
}

/**
 * What a new file starts as: the wrapper, one commented block, and nothing bound.
 * A reader edits from something that already parses rather than from an empty file.
 */
export const BINDING_FILE_TEMPLATE = `{
  "$comment": [
    "Rebind a key by naming the context it belongs to and the action it performs.",
    "Set a key to null to take it back without giving it a new job.",
    "Run /doctor to see what was refused and why."
  ],
  "bindings": [
    {
      "context": "select",
      "bindings": {}
    }
  ]
}
`;

export interface LoadedBindings {
  table: BindingTable;
  problems: readonly OverrideProblem[];
  /** False when no file exists, which is not a problem and says nothing. */
  fromFile: boolean;
}

let loaded: LoadedBindings = { table: DEFAULT_BINDINGS, problems: [], fromFile: false };

/** The table in force. Cheap: it is the held one, never a read. */
export function activeBindings(): BindingTable {
  return loaded.table;
}

/** What the last read refused, for whoever tells the reader about it. */
export function bindingProblems(): readonly OverrideProblem[] {
  return loaded.problems;
}

/**
 * Re-reads the file and puts its table in force. A file that will not parse keeps
 * the shipped table rather than a half-applied one — a reader mid-edit should not
 * lose the keys they were not editing.
 */
export function reloadBindings(): LoadedBindings {
  const path = bindingFilePath();
  if (!existsSync(path)) {
    loaded = { table: DEFAULT_BINDINGS, problems: [], fromFile: false };
    return loaded;
  }
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    loaded = {
      table: DEFAULT_BINDINGS,
      problems: [{ at: "(file)", message: unreadable(error) }],
      fromFile: true,
    };
    return loaded;
  }
  const { table, problems } = applyBindingOverrides(document);
  loaded = { table, problems, fromFile: true };
  return loaded;
}

/**
 * Makes sure a file exists to edit, without ever writing over one. Answers with
 * the path and whether this call is what created it.
 */
export function ensureBindingFile(): { path: string; created: boolean } {
  const path = bindingFilePath();
  if (existsSync(path)) return { path, created: false };
  mkdirSync(configRoot(), { recursive: true });
  writeFileSync(path, BINDING_FILE_TEMPLATE, "utf8");
  return { path, created: true };
}

/** Drops the held table, so a test starts from the shipped one. */
export function resetBindingsForTests(): void {
  loaded = { table: DEFAULT_BINDINGS, problems: [], fromFile: false };
}

function unreadable(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `could not be read as JSON, so no binding changed — ${detail}`;
}
