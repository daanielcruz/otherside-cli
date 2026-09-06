import { statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { SlashCommand } from "@/commands/catalog.ts";
import type { SlashContext, SlashResult } from "@/commands/types.ts";
import { expandHome } from "@/kernel/std/fs/paths.ts";

/**
 * Granting the session a directory outside the one it started in.
 *
 * A path is only worth adding when it exists, is a directory, and is not already
 * reachable — a path inside a directory already granted adds nothing, and saying
 * so is more use than a second entry that changes nothing.
 */

export type AddDirectoryOutcome =
  | { kind: "empty" }
  | { kind: "missing"; written: string; path: string }
  | { kind: "not-a-directory"; written: string; path: string }
  | { kind: "already"; written: string; within: string; exact: boolean; isCwd: boolean }
  | { kind: "added"; path: string };

export function readDirectoryArgument(
  written: string,
  granted: readonly string[],
  cwd: string,
): AddDirectoryOutcome {
  const trimmed = written.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  // resolve() also strips the trailing slash an expanded path can carry, so
  // `/foo` and `/foo/` are one directory rather than two entries.
  const path = resolve(cwd, expandHome(trimmed));

  let isDirectory: boolean;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    // Missing, not a directory on the way down, or unreadable: each means the
    // session cannot be given it, and none should stop the reader's turn.
    return { kind: "missing", written: trimmed, path };
  }
  if (!isDirectory) return { kind: "not-a-directory", written: trimmed, path };

  for (const reachable of [cwd, ...granted]) {
    if (!isWithin(path, reachable)) continue;
    return {
      kind: "already",
      written: trimmed,
      within: reachable,
      exact: resolve(reachable) === path,
      isCwd: reachable === cwd,
    };
  }
  return { kind: "added", path };
}

/** Whether `path` is `root` or sits under it. */
export function isWithin(path: string, root: string): boolean {
  const base = resolve(root);
  if (path === base) return true;
  return path.startsWith(base.endsWith(sep) ? base : base + sep);
}

export function addDirectoryFeedback(outcome: AddDirectoryOutcome): string {
  switch (outcome.kind) {
    case "empty":
      return "Give a directory to add.";
    case "missing":
      return `${outcome.path} was not found.`;
    case "not-a-directory":
      return `${outcome.written} is not a directory. Did you mean ${dirname(outcome.path)}?`;
    case "already": {
      if (outcome.exact) {
        return outcome.isCwd
          ? `${outcome.written} is already the working directory.`
          : `${outcome.written} is already a working directory.`;
      }
      const held = outcome.isCwd ? "the working directory" : "the added directory";
      return `${outcome.written} is already reachable within ${held} ${outcome.within}.`;
    }
    case "added":
      return `Added ${outcome.path} as a working directory.`;
  }
}

export async function handleAddDir(
  cmd: SlashCommand,
  args: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  const cwd = ctx.session?.cwd ?? process.cwd();
  const { loadAdditionalDirectories } = await import("@/kernel/permissions/persist.ts");
  const granted = await loadAdditionalDirectories(cwd).catch(() => [] as string[]);
  const outcome = readDirectoryArgument(args, granted, cwd);

  if (outcome.kind === "added") {
    const { grantWorkingDirectory } = await import("@/kernel/permissions/persist.ts");
    await grantWorkingDirectory(outcome.path);
    // Servers were told the set can change, so they are told when it does.
    const { announceRootsChanged } = await import("@/engine/mcp/roots.ts");
    announceRootsChanged();
    const { fireDirectoryAddedHooksInBackground } = await import("@/kernel/hooks/handler.ts");
    const { resolveConfig } = await import("@/kernel/config/resolver.ts");
    fireDirectoryAddedHooksInBackground(resolveConfig(cwd), {
      directory: outcome.path,
      source: "user",
      sessionId: ctx.session?.id ?? "",
      cwd,
    });
  }

  return { kind: "instant", command: cmd, feedback: addDirectoryFeedback(outcome) };
}
