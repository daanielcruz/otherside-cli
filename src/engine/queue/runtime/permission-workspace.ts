import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolveManagedSessionWorktreePath } from "@/engine/session/worktree.ts";
import { isReadOnlyBashCommand } from "@/engine/tools/_infra/command-analysis/read-only.ts";
import { loadAdditionalDirectories } from "@/kernel/permissions/persist.ts";
import { isAcceptEditsBash, isAcceptEditsTool } from "@/kernel/permissions/sensitive-paths.ts";
import { type PermissionUpdate, permissionDirectoryGlob } from "@/kernel/permissions/types.ts";
import { canonicalizeCwd, startsWithDir } from "@/kernel/std/fs/paths.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import { autoMemDir } from "@/kernel/storage/memory/entrypoint.ts";
import type { PermissionResolutionDeps } from "./permission-resolution.ts";
import { canonicalizeWorkingDirectory } from "./working-directories.ts";

const READ_ONLY_PATH_TOOLS = new Set(["Read"]);
const initializedWorkingDirectorySessions = new WeakSet<object>();
const fallbackWorkingDirectories = new WeakMap<object, Set<string>>();

export async function ensureConfiguredWorkingDirectories(
  deps: PermissionResolutionDeps,
): Promise<void> {
  const session = deps.agentDeps.session;
  if (initializedWorkingDirectorySessions.has(session)) return;
  initializedWorkingDirectorySessions.add(session);
  const directories = activeAdditionalWorkingDirectories(deps);
  for (const directory of await loadAdditionalDirectories(session.cwd)) {
    const canonical = canonicalizeWorkingDirectory(directory, session.cwd);
    if (canonical !== null) directories.add(canonical);
  }
}

export function readFilePathFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as { file_path?: unknown }).file_path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function workflowNameFromInput(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const value = input.name;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function enterWorktreeExternalPath(input: unknown, cwd: string): Promise<boolean> {
  if (!isRecord(input) || typeof input.path !== "string" || input.path.length === 0) {
    return false;
  }
  return (await resolveManagedSessionWorktreePath(cwd, input.path)) === null;
}

export function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
  return filePath;
}

export function canonicalizeBestEffort(
  absolute: string,
  realpath: (path: string) => string = realpathSync,
): string {
  const tail: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const real = realpath(current);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.push(basename(current));
      current = parent;
    }
  }
}

export function filePathRepresentations(
  filePath: string,
  cwd: string,
  includeIntermediateSymlinkTargets: boolean,
): string[] {
  const expanded = expandHome(filePath);
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const paths = new Set([filePath, absolute]);

  // A final realpath loses links in a chain (e.g. a -> b -> /etc/passwd). Rule
  // matching retains each direct target; session suggestions retain only file paths.
  const ancestors: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    ancestors.unshift(current);
    if (dirname(current) === current) break;
  }
  for (const [index, path] of ancestors.entries()) {
    const tail = ancestors.slice(index + 1).map((ancestor) => basename(ancestor));
    let current = path;
    for (let depth = 0; depth < 40; depth += 1) {
      try {
        if (!lstatSync(current).isSymbolicLink()) break;
        const target = readlinkSync(current);
        current = isAbsolute(target) ? target : resolve(dirname(current), target);
        if (includeIntermediateSymlinkTargets) paths.add(current);
        paths.add(resolve(current, ...tail));
      } catch {
        // A missing or inaccessible component still has its lexical and final
        // best-effort representations checked below.
        break;
      }
    }
  }
  paths.add(canonicalizeBestEffort(absolute));
  return [...paths];
}

export function filesystemReadSessionSuggestions(
  filePath: string | null,
  cwd: string,
  additionalWorkingDirectories: Iterable<string>,
): PermissionUpdate[] {
  if (
    filePath === null ||
    pathWithinWorkspace(filePath, cwd, realpathSync, additionalWorkingDirectories)
  )
    return [];
  const directories = new Set(
    filePathRepresentations(filePath, cwd, false).map((path) => dirname(path)),
  );
  return [
    {
      type: "addRules",
      destination: "session",
      rules: [...directories].map((directory) => ({
        source: "session",
        ruleBehavior: "allow",
        ruleValue: {
          toolName: "Read",
          ruleContent: permissionDirectoryGlob(directory),
        },
      })),
    },
  ];
}

export function pathWithinWorkspace(
  filePath: string,
  cwd: string,
  realpath: (path: string) => string = realpathSync,
  additionalWorkingDirectories: Iterable<string> = [],
): boolean {
  const realCwd = canonicalizeBestEffort(resolve(cwd), realpath);
  const expanded = expandHome(filePath);
  const absolute = isAbsolute(expanded) ? expanded : resolve(realCwd, expanded);
  const canonicalPath = canonicalizeBestEffort(absolute, realpath);
  for (const workingDirectory of [realCwd, ...additionalWorkingDirectories]) {
    const canonicalDirectory = canonicalizeBestEffort(resolve(workingDirectory), realpath);
    if (startsWithDir(canonicalPath, canonicalDirectory)) return true;
  }
  return false;
}

export function bashCommandFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const cmd = (input as { command?: unknown }).command;
  return typeof cmd === "string" ? cmd : null;
}

export function editFilePathFromInput(toolName: string, input: unknown): string | null {
  if (!isAcceptEditsTool(toolName) || !input || typeof input !== "object") return null;
  const key = toolName === "NotebookEdit" ? "notebook_path" : "file_path";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isWorkspaceEdit(
  toolName: string,
  input: unknown,
  cwd: string,
  additionalWorkingDirectories: Iterable<string>,
): boolean {
  const filePath = editFilePathFromInput(toolName, input);
  return (
    filePath !== null &&
    pathWithinWorkspace(filePath, cwd, realpathSync, additionalWorkingDirectories)
  );
}

// The CLI's own auto-memory directory lives outside the workspace and under
// `.otherside` (a sensitive segment), so it would otherwise force a prompt in
// every mode. Writing there is the memory subsystem doing its job (e.g. /dream),
// so auto-allow it unless an explicit deny/ask rule intervenes.
export function isAutoMemoryEdit(toolName: string, input: unknown, cwd: string): boolean {
  const filePath = editFilePathFromInput(toolName, input);
  if (filePath === null) return false;
  const expanded = expandHome(filePath);
  const absolute = isAbsolute(expanded) ? expanded : resolve(canonicalizeCwd(cwd), expanded);
  return startsWithDir(canonicalizeBestEffort(absolute), canonicalizeBestEffort(autoMemDir(cwd)));
}

export function outsideEditDirectory(
  toolName: string,
  input: unknown,
  cwd: string,
  additionalWorkingDirectories: Iterable<string>,
): string | null {
  const filePath = editFilePathFromInput(toolName, input);
  if (
    filePath === null ||
    pathWithinWorkspace(filePath, cwd, realpathSync, additionalWorkingDirectories)
  )
    return null;
  const expanded = expandHome(filePath);
  return dirname(isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded));
}

export function isAcceptEditsBashInWorkingDirectories(
  command: string,
  cwd: string,
  additionalWorkingDirectories: Iterable<string>,
): boolean {
  if (isAcceptEditsBash(command, cwd)) return true;
  const tokens = command.match(/'(?:[^']*)'|"(?:[^"$\\`]*)"|[^\s]+/g);
  if (!tokens) return false;
  const operands = tokens.slice(1).filter((token) => {
    const unquoted = token.replace(/^['"]|['"]$/g, "");
    return !unquoted.startsWith("-") && !/^\d*(?:>|<|&)/.test(unquoted);
  });
  if (operands.length === 0) return false;
  const absoluteOperands = operands.map((token) => token.replace(/^['"]|['"]$/g, ""));
  if (absoluteOperands.some((operand) => !isAbsolute(expandHome(operand)))) return false;
  if (
    absoluteOperands.some(
      (operand) => !pathWithinWorkspace(operand, cwd, realpathSync, additionalWorkingDirectories),
    )
  )
    return false;
  for (const workingDirectory of additionalWorkingDirectories) {
    if (isAcceptEditsBash(command, workingDirectory)) return true;
  }
  return false;
}

export function isReadOnlyToolCheck(toolName: string, input: unknown): boolean {
  if (toolName === "Read") return true;
  if (toolName === "Bash") {
    const cmd = bashCommandFromInput(input);
    return cmd !== null && isReadOnlyBashCommand(cmd);
  }
  return false;
}

export function isWorkspaceRead(
  toolName: string,
  input: unknown,
  cwd: string,
  realpath: (path: string) => string = realpathSync,
  additionalWorkingDirectories: Iterable<string> = [],
): boolean {
  if (!READ_ONLY_PATH_TOOLS.has(toolName)) return false;
  const filePath = readFilePathFromInput(input);
  return (
    filePath !== null && pathWithinWorkspace(filePath, cwd, realpath, additionalWorkingDirectories)
  );
}

export function activeAdditionalWorkingDirectories(deps: PermissionResolutionDeps): Set<string> {
  const session = deps.agentDeps.session;
  if (session.additionalWorkingDirectories) return session.additionalWorkingDirectories;
  const existing = fallbackWorkingDirectories.get(session);
  if (existing) return existing;
  const created = new Set<string>();
  fallbackWorkingDirectories.set(session, created);
  return created;
}
