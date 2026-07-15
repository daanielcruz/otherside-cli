import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentContext } from "@/engine/agents/agent-context.ts";
import { isReadOnlyBashCommand } from "@/engine/tools/_infra/command-analysis/read-only.ts";
import { permissionAbortSignal } from "@/engine/tools/permission-abort-context.ts";
import type { PermissionDecision } from "@/engine/tools/pipeline.ts";
import { isActivePlanFileWrite } from "@/engine/tools/plan-gate.ts";
import { preToolUseHookPermissionSignal } from "@/engine/tools/pretooluse-hook-permission-context.ts";
import * as registry from "@/engine/tools/registry.ts";
import type { InjectionQueue } from "@/harness/composer/injections.ts";
import { ask as askPermission } from "@/kernel/channels/permission.ts";
import { isMcpAuthToolName } from "@/kernel/mcp/auth/dynamic-tools.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import {
  containsUnsafeRedirect,
  stripLeadingSafeEnvVars,
  stripSafeWrappers,
  tokenizeRespectingQuotes,
} from "@/kernel/permissions/bash-matcher.ts";
import {
  permissionInputForCall,
  permissionKeyForCall,
  permissionRuleValueFromString,
  permissionTargetFieldFromInput,
  RuleStore,
} from "@/kernel/permissions/index.ts";
import {
  loadAdditionalDirectories,
  loadRules,
  persistAdditionalDirectoryUpdate,
  saveRules,
} from "@/kernel/permissions/persist.ts";
import {
  isAcceptEditsBash,
  isAcceptEditsTool,
  isSensitiveFilePath,
  isSensitiveWriteApprovable,
  splitBashSubcommands,
} from "@/kernel/permissions/sensitive-paths.ts";
import {
  type PermissionBehavior,
  type PermissionRule,
  type PermissionUpdate,
  permissionDirectoryGlob,
  permissionRuleValueToString,
} from "@/kernel/permissions/types.ts";
import { canonicalizeCwd, startsWithDir } from "@/kernel/std/fs/paths.ts";
import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import { autoMemDir } from "@/kernel/storage/memory/entrypoint.ts";
import { previewArgs } from "./args-preview.ts";
import { recordHeadlessDenial } from "./headless-denials.ts";
import type { AgentDeps } from "./turn/types.ts";
import { canonicalizeWorkingDirectory, resolveWorkingDirectory } from "./working-directories.ts";

// Headless (`--print`) has no UI to answer permission prompts. A tool that reaches the interactive ask is auto-denied and recorded, avoiding an indefinite hang from a never-resolving `ask()` call. Accept-edits and yolo grants are already applied before this check, so only genuinely prompt-requiring calls land here.
async function headlessAutoDeny(
  deps: PermissionResolutionDeps,
  call: ToolCall,
): Promise<PermissionDecision> {
  recordHeadlessDenial(deps.agentDeps.session.id, {
    tool_name: call.name,
    tool_use_id: call.id,
    tool_input: isRecord(call.input) ? call.input : {},
  });
  return {
    kind: "deny",
    message:
      "Permission denied: this tool needs interactive approval, unavailable in headless (--print) mode. Re-run with --permission-mode acceptEdits, --allowedTools, or --dangerously-skip-permissions to authorize it.",
  };
}

const DENIAL_WORKAROUND_GUIDANCE =
  "IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, " +
  "e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, " +
  "e.g. do not use your ability to run tests to execute non-test actions. " +
  "You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. " +
  "If you believe this capability is essential to complete the user's request, STOP and explain to the user " +
  "what you were trying to do and why you need this permission. Let the user decide how to proceed.";

function autoRejectMessage(toolName: string): string {
  return `Permission to use ${toolName} has been denied. ${DENIAL_WORKAROUND_GUIDANCE}`;
}

function backgroundAgentAutoDeny(call: ToolCall): PermissionDecision {
  return { kind: "deny", message: autoRejectMessage(call.name) };
}

const PERMISSION_FREE_TOOLS = new Set([
  "Agent",
  "EnterPlanMode",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "ReportFindings",
  "ToolSearch",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
  "ScheduleWakeup",
  "SendMessage",
  "StructuredOutput",
  "WaitForMcpServers",
]);

const READ_ONLY_PATH_TOOLS = new Set(["Read"]);
const initializedWorkingDirectorySessions = new WeakSet<object>();
const fallbackWorkingDirectories = new WeakMap<object, Set<string>>();

async function ensureConfiguredWorkingDirectories(deps: PermissionResolutionDeps): Promise<void> {
  const session = deps.agentDeps.session;
  if (initializedWorkingDirectorySessions.has(session)) return;
  initializedWorkingDirectorySessions.add(session);
  const directories = activeAdditionalWorkingDirectories(deps);
  for (const directory of await loadAdditionalDirectories(session.cwd)) {
    const canonical = canonicalizeWorkingDirectory(directory, session.cwd);
    if (canonical !== null) directories.add(canonical);
  }
}

function readFilePathFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as { file_path?: unknown }).file_path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function workflowNameFromInput(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const value = input.name;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
  return filePath;
}

function canonicalizeBestEffort(
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

function filePathRepresentations(
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

function filesystemReadSessionSuggestions(
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

function pathWithinWorkspace(
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

function bashCommandFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const cmd = (input as { command?: unknown }).command;
  return typeof cmd === "string" ? cmd : null;
}

function editFilePathFromInput(toolName: string, input: unknown): string | null {
  if (!isAcceptEditsTool(toolName) || !input || typeof input !== "object") return null;
  const key = toolName === "NotebookEdit" ? "notebook_path" : "file_path";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isWorkspaceEdit(
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
function isAutoMemoryEdit(toolName: string, input: unknown, cwd: string): boolean {
  const filePath = editFilePathFromInput(toolName, input);
  if (filePath === null) return false;
  const expanded = expandHome(filePath);
  const absolute = isAbsolute(expanded) ? expanded : resolve(canonicalizeCwd(cwd), expanded);
  return startsWithDir(canonicalizeBestEffort(absolute), canonicalizeBestEffort(autoMemDir(cwd)));
}

function outsideEditDirectory(
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

function isAcceptEditsBashInWorkingDirectories(
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

function isReadOnlyToolCheck(toolName: string, input: unknown): boolean {
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

export interface PermissionResolutionDeps {
  agentDeps: AgentDeps;
  injections: InjectionQueue;
  sessionAllowedToolPatterns: Set<string>;
}

// Read live from the broker on every decision — a mode change (shift+tab to
// yolo/plan mid-turn, or a remote client) must apply to the very next tool
// call, never wait for the turn to end. A live yolo/accept-edits beats an
// agent-definition mode pinned at spawn; in every other live mode the pinned
// override governs that agent's run.
function currentPermissionMode(deps: PermissionResolutionDeps): PermissionMode {
  const live = deps.agentDeps.broker.read().permissionMode;
  if (live === "yolo" || live === "accept-edits") return live;
  return getAgentContext()?.permissionModeOverride ?? live;
}

// The set a new session-allow grant is written into. Inside a fork that's the
// fork's own AgentContext set (fresh per fork), never the parent's deps — a
// grant a fork makes for itself during its own run accumulates there (no
// re-prompting within it) without writing back into the parent's set. On the
// main turn (no AgentContext) it's the session's own set directly.
export function activeSessionAllowSet(deps: PermissionResolutionDeps): Set<string> {
  return getAgentContext()?.sessionAllowedToolPatterns ?? deps.sessionAllowedToolPatterns;
}

// The patterns a call is matched against. A fork still honors whatever the
// parent already granted for the session — `deps.sessionAllowedToolPatterns`
// is closed over live from the spawning scope, so this also picks up a grant
// the parent makes *after* the fork started, matching upstream's parent
// permission-context inheritance. Layered on top (never replacing it) is the
// fork's own local grants, so an inherited allow can never shadow a grant the
// fork made for itself, and a fork's own grants still don't leak back into
// the parent (see `activeSessionAllowSet`, used for writes). Explicit deny/ask
// rules are matched separately in `resolvePermission` and always take
// precedence over any allow pattern collected here.
export function sessionAllowPatternsForMatch(deps: PermissionResolutionDeps): Iterable<string> {
  const forkLocal = getAgentContext()?.sessionAllowedToolPatterns;
  if (forkLocal === undefined || forkLocal.size === 0) return deps.sessionAllowedToolPatterns;
  if (deps.sessionAllowedToolPatterns.size === 0) return forkLocal;
  return new Set([...deps.sessionAllowedToolPatterns, ...forkLocal]);
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

const MAX_COMPOUND_BASH_SEGMENTS = 50;

type BashWriteCommand = "mkdir" | "touch" | "rm" | "rmdir" | "mv" | "cp" | "sed";

type BashReadCommand =
  | "cat"
  | "column"
  | "comm"
  | "cmp"
  | "cut"
  | "df"
  | "diff"
  | "du"
  | "file"
  | "find"
  | "fold"
  | "grep"
  | "egrep"
  | "fgrep"
  | "git"
  | "head"
  | "hexdump"
  | "jq"
  | "ls"
  | "md5sum"
  | "nl"
  | "od"
  | "paste"
  | "pr"
  | "rg"
  | "rev"
  | "sed"
  | "sha1sum"
  | "sha256sum"
  | "sort"
  | "stat"
  | "strings"
  | "tac"
  | "tail"
  | "tree"
  | "tr"
  | "unexpand"
  | "uniq"
  | "wc";

const BASH_WRITE_COMMANDS = new Set<BashWriteCommand>([
  "mkdir",
  "touch",
  "rm",
  "rmdir",
  "mv",
  "cp",
  "sed",
]);

const BASH_READ_COMMANDS = new Set<BashReadCommand>([
  "cat",
  "column",
  "comm",
  "cmp",
  "cut",
  "df",
  "diff",
  "du",
  "file",
  "find",
  "fold",
  "grep",
  "egrep",
  "fgrep",
  "git",
  "head",
  "hexdump",
  "jq",
  "ls",
  "md5sum",
  "nl",
  "od",
  "paste",
  "pr",
  "rg",
  "rev",
  "sed",
  "sha1sum",
  "sha256sum",
  "sort",
  "stat",
  "strings",
  "tac",
  "tail",
  "tree",
  "tr",
  "unexpand",
  "uniq",
  "wc",
]);

function positionalArgs(args: string[]): string[] {
  const paths: string[] = [];
  let afterDoubleDash = false;
  for (const arg of args) {
    if (afterDoubleDash) paths.push(arg);
    else if (arg === "--") afterDoubleDash = true;
    else if (!arg.startsWith("-")) paths.push(arg);
  }
  return paths;
}

function sedWritePaths(args: string[]): string[] {
  const paths: string[] = [];
  let scriptFound = false;
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      if (arg === "-f" || arg === "--file") {
        const scriptFile = args[i + 1];
        if (scriptFile) {
          paths.push(scriptFile);
          i++;
        }
        scriptFound = true;
      } else if (arg === "-e" || arg === "--expression") {
        i++;
        scriptFound = true;
      } else if (arg.includes("e") || arg.includes("f")) {
        scriptFound = true;
      }
      continue;
    }
    if (!scriptFound) scriptFound = true;
    else paths.push(arg);
  }
  return paths;
}

function patternReadPaths(
  args: string[],
  flagsWithArgs: ReadonlySet<string>,
  defaults: string[] = [],
): string[] {
  const paths: string[] = [];
  let patternFound = false;
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      const flag = arg.split("=")[0] ?? arg;
      if (flag === "-e" || flag === "--regexp" || flag === "-f" || flag === "--file") {
        patternFound = true;
      }
      if (flagsWithArgs.has(flag) && !arg.includes("=")) i++;
      continue;
    }
    if (!patternFound) patternFound = true;
    else paths.push(arg);
  }
  return paths.length > 0 ? paths : defaults;
}

function findReadPaths(args: string[]): string[] {
  const paths: string[] = [];
  const pathFlags = new Set([
    "-newer",
    "-anewer",
    "-cnewer",
    "-mnewer",
    "-samefile",
    "-path",
    "-wholename",
    "-ilname",
    "-lname",
    "-ipath",
    "-iwholename",
  ]);
  const newerPattern = /^-newer[acmBt][acmtB]$/;
  let foundNonGlobalFlag = false;
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (afterDoubleDash) {
      paths.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg.startsWith("-")) {
      if (arg === "-H" || arg === "-L" || arg === "-P") continue;
      foundNonGlobalFlag = true;
      if (pathFlags.has(arg) || newerPattern.test(arg)) {
        const path = args[i + 1];
        if (path) {
          paths.push(path);
          i++;
        }
      }
      continue;
    }
    if (!foundNonGlobalFlag) paths.push(arg);
  }
  return paths.length > 0 ? paths : ["."];
}

function trReadPaths(args: string[]): string[] {
  const hasDelete = args.some(
    (arg) => arg === "-d" || arg === "--delete" || (arg.startsWith("-") && arg.includes("d")),
  );
  return positionalArgs(args).slice(hasDelete ? 1 : 2);
}

function jqReadPaths(args: string[]): string[] {
  const flagsWithArgs = new Set([
    "-e",
    "--expression",
    "-f",
    "--from-file",
    "--arg",
    "--argjson",
    "--slurpfile",
    "--rawfile",
    "--args",
    "--jsonargs",
    "-L",
    "--library-path",
    "--indent",
    "--tab",
  ]);
  return patternReadPaths(args, flagsWithArgs);
}

function bashReadPaths(segment: string): string[] | null {
  const tokens = unwrapBashPathWrappers(tokenizeRespectingQuotes(segment.trim()));
  if (tokens === null) return [];
  const command = tokens[0];
  if (!command || !BASH_READ_COMMANDS.has(command as BashReadCommand)) return null;
  const args = tokens.slice(1);
  switch (command) {
    case "find":
      return findReadPaths(args);
    case "grep":
    case "egrep":
    case "fgrep":
      return patternReadPaths(
        args,
        new Set([
          "-e",
          "--regexp",
          "-f",
          "--file",
          "--exclude",
          "--include",
          "--exclude-dir",
          "--include-dir",
          "-m",
          "--max-count",
          "-A",
          "--after-context",
          "-B",
          "--before-context",
          "-C",
          "--context",
        ]),
        args.some((arg) => arg === "-r" || arg === "-R" || arg === "--recursive") ? ["."] : [],
      );
    case "rg":
      return patternReadPaths(
        args,
        new Set([
          "-e",
          "--regexp",
          "-f",
          "--file",
          "-t",
          "--type",
          "-T",
          "--type-not",
          "-g",
          "--glob",
          "-m",
          "--max-count",
          "--max-depth",
          "-r",
          "--replace",
          "-A",
          "--after-context",
          "-B",
          "--before-context",
          "-C",
          "--context",
        ]),
        ["."],
      );
    case "sed":
      return sedWritePaths(args);
    case "git":
      return args[0] === "diff" && args.includes("--no-index")
        ? positionalArgs(args.slice(1)).slice(0, 2)
        : [];
    case "tr":
      return trReadPaths(args);
    case "jq":
      return jqReadPaths(args);
    case "ls":
      return positionalArgs(args).length > 0 ? positionalArgs(args) : ["."];
    default:
      return positionalArgs(args);
  }
}

interface BashWritePaths {
  paths: string[];
  hasUnsupportedFlags: boolean;
}

// `env` executes the command after its own assignments and options. Only peel
// the forms that leave argv intact; `-S` splits argv while `-C`/`-P` change
// resolution, so those (and unknown or incomplete options) must prompt.
function unwrapEnvForBashPathValidation(tokens: string[]): string[] | null {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) return null;
    if (token.includes("=") && !token.startsWith("-")) index++;
    else if (token === "-i" || token === "-0" || token === "-v") index++;
    else if (token === "-u" && tokens[index + 1]) index += 2;
    else if (token.startsWith("-")) return null;
    else break;
  }
  return index < tokens.length ? tokens.slice(index) : null;
}

function unwrapBashPathWrappers(tokens: string[]): string[] | null {
  let unwrapped = stripSafeWrappers(stripLeadingSafeEnvVars(tokens));
  while (unwrapped[0] === "env") {
    const next = unwrapEnvForBashPathValidation(unwrapped);
    if (next === null) return null;
    unwrapped = stripSafeWrappers(next);
  }
  return unwrapped;
}

function bashWritePaths(segment: string): BashWritePaths | null {
  const tokens = unwrapBashPathWrappers(tokenizeRespectingQuotes(segment.trim()));
  // An unparseable env wrapper can change the effective argv or path lookup.
  // Treat it as a write candidate so saved allow rules cannot bypass a prompt.
  if (tokens === null) return { paths: [], hasUnsupportedFlags: true };
  const command = tokens[0];
  if (!command || !BASH_WRITE_COMMANDS.has(command as BashWriteCommand)) return null;
  const args = tokens.slice(1);
  if (command === "sed" && isReadOnlyBashCommand(segment)) return null;
  return {
    paths: command === "sed" ? sedWritePaths(args) : positionalArgs(args),
    hasUnsupportedFlags:
      (command === "cp" || command === "mv") && args.some((arg) => arg.startsWith("-")),
  };
}

function bashWritePathDecision(
  command: string,
  cwd: string,
  additionalWorkingDirectories: Iterable<string>,
): "ask" | null {
  const segments = splitBashSubcommands(command)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const compoundHasCd =
    segments.length > 1 && segments.some((segment) => /^cd(?:\s|$)/.test(segment));
  for (const segment of segments) {
    const write = bashWritePaths(segment);
    if (!write) continue;
    // As upstream does, fail closed on cp/mv flags: --target-directory and
    // similar options can carry a destination outside the positional argv.
    if (write.hasUnsupportedFlags || compoundHasCd) return "ask";
    for (const filePath of write.paths) {
      // Shell/runtime expansions and write globs cannot be resolved before the
      // command runs, so they must never be authorized by a saved Bash rule.
      if (
        filePath.includes("$") ||
        filePath.includes("%") ||
        filePath.startsWith("=") ||
        (filePath.startsWith("~") && filePath !== "~" && !filePath.startsWith("~/")) ||
        /[*?[\]{}]/.test(filePath)
      )
        return "ask";
      // Check every symlink-chain / best-effort resolved representation, not
      // just the lexical operand — a link into a sensitive directory (e.g.
      // `alias -> .git`) must still trigger a prompt for `touch alias/config`.
      if (
        filePathRepresentations(filePath, cwd, true).some((path) => isSensitiveFilePath(path, cwd))
      )
        return "ask";
      if (!pathWithinWorkspace(filePath, cwd, realpathSync, additionalWorkingDirectories))
        return "ask";
    }
  }
  return null;
}

// A coarser signal than `bashWritePathDecision`: whether ANY segment of a
// (possibly compound) command is a recognized filesystem-mutating command
// (mkdir/touch/rm/rmdir/mv/cp/sed), regardless of whether its target path is
// workspace-safe. Used only to gate plan mode's already-granted-allow-rule
// fast path (MCP-PLAN-001) — a `Bash(mkdir foo:*)` allow rule must still
// prompt in plan mode even though the path itself would otherwise be a safe,
// no-`ask` write. Commands outside BASH_WRITE_COMMANDS (e.g. `npm test`) are
// intentionally NOT treated as writes here, matching upstream: an explicit
// Bash allow rule for a non-filesystem command still auto-allows in plan
// mode.
function bashHasWriteCommand(command: string): boolean {
  return splitBashSubcommands(command)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .some((segment) => bashWritePaths(segment) !== null);
}

// Mirrors upstream's ROOT_VAR_EXPANSION_RE (bashPermissions.ts): an `rm`/
// `rmdir` target that is a bare $VAR or ${VAR} expansion directly followed by
// `/` and a glob, another expansion, another slash, or the end of the
// argument expands to the filesystem root (or a top-level directory) when the
// variable is unset or empty at runtime — e.g. `rm -rf $UNSET/*` becomes
// `rm -rf /*`. Quotes around the expansion (`"$UNSET"/`) are already stripped
// by tokenizeRespectingQuotes before this runs, so unlike upstream's raw-text
// regex this one doesn't need to match quote characters itself.
const DANGEROUS_RM_ROOT_VAR_RE =
  /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)\/(?:[*$/]|$)/;

// Upstream keeps this one pattern bypass-immune even while a Bash call is
// otherwise auto-allowed by an allow rule or by yolo/accept-edits mode
// (permissions.ts: `safetyReason` re-returns the ask for
// "Dangerous rm operation"/"Dangerous rmdir operation" even when
// shouldBypassPermissions is true). So — unlike the rest of
// bashWritePathDecision, whose "ask" is gated by `mode !== "yolo"` below —
// this check must be OR'd into `mustAsk` unconditionally.
function bashDangerousRmRootVarDecision(command: string): "ask" | null {
  for (const rawSegment of splitBashSubcommands(command)) {
    const segment = rawSegment.trim();
    if (!segment) continue;
    const tokens = unwrapBashPathWrappers(tokenizeRespectingQuotes(segment));
    if (tokens === null) continue;
    const name = tokens[0];
    if (name !== "rm" && name !== "rmdir") continue;
    for (const arg of positionalArgs(tokens.slice(1))) {
      if (DANGEROUS_RM_ROOT_VAR_RE.test(arg)) return "ask";
    }
  }
  return null;
}

// Mirrors upstream's isDangerousRemovalPath / pathInWorkingPath
// (tools/BashTool/pathValidation.ts, utils/permissions/pathValidation.ts): a
// path that IS the filesystem root, the user's home directory, or a direct
// child of root (e.g. `/usr`, `/etc`) is a catastrophic rm/rmdir target on
// its own; a path that is a tracked working directory (session cwd or an
// additionalWorkingDirectory) — or an ancestor of one, since removing the
// ancestor removes the working directory with it — is equally catastrophic.
// This intentionally compares the plain (lexical) resolved path rather than a
// symlink-realpath'd one: mirroring upstream's path-segment check, and
// avoiding a real filesystem quirk (e.g. macOS resolving `/etc` to
// `/private/etc`) silently moving a genuine direct-child-of-root target out
// from under the "direct child of root" shape.
function isCriticalSystemDirectory(absolutePath: string, homeDir: string): boolean {
  const parent = dirname(absolutePath);
  if (parent === absolutePath) return true; // filesystem root itself
  if (dirname(parent) === parent) return true; // direct child of root
  return absolutePath === homeDir;
}

// Upstream's checkDangerousRemovalPaths runs ahead of any allow rule and
// stays bypass-immune even while shouldBypassPermissions (yolo) is set —
// the "Dangerous rm/rmdir operation" ask reason is re-returned by
// permissions.ts's narrow dangerous-rm exception regardless of bypass state.
// Like bashDangerousRmRootVarDecision above (a distinct, narrower upstream
// pattern for unresolved `$VAR/` expansions), this must be OR'd into
// `mustAsk` unconditionally, never gated by `mode !== "yolo"`.
function bashDangerousRmCriticalPathDecision(
  command: string,
  cwd: string,
  additionalWorkingDirectories: Iterable<string>,
): "ask" | null {
  const homeDir = resolve(homedir());
  const workingDirectories = [cwd, ...additionalWorkingDirectories].map((directory) =>
    resolve(directory),
  );
  for (const rawSegment of splitBashSubcommands(command)) {
    const segment = rawSegment.trim();
    if (!segment) continue;
    const tokens = unwrapBashPathWrappers(tokenizeRespectingQuotes(segment));
    if (tokens === null) continue;
    const name = tokens[0];
    if (name !== "rm" && name !== "rmdir") continue;
    for (const arg of positionalArgs(tokens.slice(1))) {
      // An unresolved shell expansion or glob cannot be safely resolved here
      // without risking a false match on the literal text; those forms are
      // covered separately by bashDangerousRmRootVarDecision (root-shaped
      // `$VAR/` expansions) and, for any resulting non-workspace target, by
      // bashWritePathDecision's mode-gated ask.
      if (arg.includes("$") || arg.includes("%") || /[*?[\]{}]/.test(arg)) continue;
      const expanded = expandHome(arg);
      const absoluteTarget = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
      if (isCriticalSystemDirectory(absoluteTarget, homeDir)) return "ask";
      if (workingDirectories.some((directory) => startsWithDir(directory, absoluteTarget)))
        return "ask";
    }
  }
  return null;
}

function bashReadPathDecision(
  command: string,
  cwd: string,
  additionalWorkingDirectories: Iterable<string>,
): "ask" | null {
  if (!isReadOnlyBashCommand(command)) return null;
  for (const segment of splitBashSubcommands(command)) {
    const paths = bashReadPaths(segment);
    if (paths === null) continue;
    for (const filePath of paths) {
      if (!pathWithinWorkspace(filePath, cwd, realpathSync, additionalWorkingDirectories)) {
        return "ask";
      }
    }
  }
  return null;
}

// `cd` is not a content-reading command, so it never appears in
// BASH_READ_COMMANDS and isReadOnlyBashCommand() does not classify it —
// which means bashReadPathDecision's whole-command read-only gate never even
// looks at a `cd` segment. A compound like `cd <outside> && cat secret`
// would otherwise reach compoundBashDecision, where separately allow-ruled
// `cd *` and `cat *` segments combine into an unprompted "allow" even though
// the `cd` destination itself leaves the workspace and every later relative
// operand is actually resolved there at runtime, not against the original
// cwd. Checked independently of isReadOnlyBashCommand so both a bare
// `cd <outside>` and any compound containing it are covered — matching
// upstream's PATH_EXTRACTORS.cd, which validates the cd target for every
// Bash call, not only compounds. Multiple `cd`s or unresolvable destinations
// (globs, `$VAR`, unparseable wrappers) fail closed to "ask" rather than
// attempt to track an effective cwd across segments.
function bashCdPathDecision(
  command: string,
  cwd: string,
  additionalWorkingDirectories: Iterable<string>,
): "ask" | null {
  for (const segment of splitBashSubcommands(command)) {
    const trimmed = segment.trim();
    if (!/^cd(?:\s|$)/.test(trimmed)) continue;
    const tokens = unwrapBashPathWrappers(tokenizeRespectingQuotes(trimmed));
    // An unparseable env/wrapper form leaves the destination unknowable.
    if (tokens === null || tokens[0] !== "cd") return "ask";
    const args = tokens.slice(1);
    const destination = args.length === 0 ? homedir() : args.join(" ");
    if (
      destination.includes("$") ||
      destination.includes("%") ||
      destination.startsWith("=") ||
      (destination.startsWith("~") && destination !== "~" && !destination.startsWith("~/")) ||
      /[*?[\]{}]/.test(destination)
    )
      return "ask";
    if (!pathWithinWorkspace(destination, cwd, realpathSync, additionalWorkingDirectories)) {
      return "ask";
    }
  }
  return null;
}

export interface CompoundBashProbes {
  matchSub: (sub: string) => PermissionBehavior | null;
  subSessionAllowed: (sub: string) => boolean;
  subAutoAllowed: (sub: string) => boolean;
}

// Single-rule matchers refuse compound commands outright (a `sleep *` allow
// must not bless `sleep 1 && rm -rf /`), so compounds are decided here by
// evaluating EVERY chained segment on its own: any denied segment denies the
// call, an explicit ask-rule forces the prompt, and the call is auto-allowed
// only when each segment is individually allowed (rule, session grant, or
// read-only). Substitution/newline commands stay un-splittable → prompt.
export function compoundBashDecision(
  command: string,
  probes: CompoundBashProbes,
): "allow" | "deny" | "ask" | "rule-ask" | null {
  if (command.includes("\n") || /\$\(|`/.test(command)) return null;
  const segments = splitBashSubcommands(command)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length <= 1) return null;
  if (segments.length > MAX_COMPOUND_BASH_SEGMENTS) return "ask";
  const cdCount = segments.filter((segment) => /^cd(?:\s|$)/.test(segment)).length;
  if (cdCount > 1) return "ask";
  if (cdCount === 1 && segments.some((segment) => bashWritePaths(segment) !== null)) return "ask";
  if (cdCount === 1 && segments.some((segment) => /^git(?:\s|$)/.test(segment))) return "ask";
  let allAllowed = true;
  for (const segment of segments) {
    const matched = probes.matchSub(segment);
    if (matched === "deny") return "deny";
    if (matched === "ask") return "rule-ask";
    if (matched === "allow" || probes.subSessionAllowed(segment)) continue;
    if (!containsUnsafeRedirect(segment) && probes.subAutoAllowed(segment)) continue;
    allAllowed = false;
  }
  return allAllowed ? "allow" : null;
}

export async function resolvePermission(
  deps: PermissionResolutionDeps,
  call: ToolCall,
  signal: AbortSignal | undefined = permissionAbortSignal(),
): Promise<PermissionDecision> {
  // Dynamic MCP authenticate/complete_authentication pseudo-tools carry a
  // per-server wire name (mcp__<server>__authenticate), so they can't live in
  // the static PERMISSION_FREE_TOOLS set — matched by wire-name shape
  // instead (MCP-003).
  const permissionFree = PERMISSION_FREE_TOOLS.has(call.name) || isMcpAuthToolName(call.name);
  if (call.name === "EnterPlanMode") return "allow";
  if (call.name === "ExitPlanMode") {
    return resolveExitPlanMode(deps, call, signal);
  }
  await ensureConfiguredWorkingDirectories(deps);
  const argsPreview = previewArgs(call.input);
  const cwd = deps.agentDeps.session.cwd;
  const additionalWorkingDirectories = activeAdditionalWorkingDirectories(deps);
  const handler = registry.get(call.name);
  const requiresUserInteraction = handler?.requiresUserInteraction?.() ?? false;
  const canonicalName = handler?.schema.name ?? call.name;
  const workflowName = canonicalName === "Workflow" ? workflowNameFromInput(call.input) : null;
  const ruleInput = workflowName ?? permissionInputForCall(call.input, argsPreview);
  const aliasNames = registry.aliasNamesFor(canonicalName);
  const permissionPattern =
    workflowName === null
      ? permissionKeyForCall(call.name, call.input, argsPreview)
      : `Workflow(${workflowName})`;
  const rules = await loadRules(cwd);
  const store = new RuleStore();
  store.addAll(rules);
  for (const pattern of sessionAllowPatternsForMatch(deps)) {
    const ruleValue = permissionRuleValueFromString(pattern);
    if (ruleValue) {
      store.add({ source: "session", ruleBehavior: "allow", ruleValue });
    }
  }
  const matched = store.match(canonicalName, ruleInput, aliasNames);
  const primaryField = permissionTargetFieldFromInput(call.input);
  const fieldDenyRule = store.matchInputParam(
    canonicalName,
    call.input,
    primaryField,
    "deny",
    aliasNames,
  );
  const fieldAskRule = store.matchInputParam(
    canonicalName,
    call.input,
    primaryField,
    "ask",
    aliasNames,
  );
  const filePath =
    canonicalName === "Read"
      ? readFilePathFromInput(call.input)
      : editFilePathFromInput(canonicalName, call.input);
  const fileRuleToolName = canonicalName === "Read" ? "Read" : "Edit";
  const fileRulePaths = filePath === null ? [] : filePathRepresentations(filePath, cwd, true);
  const matchesFileRule = (behavior: "deny" | "ask") =>
    fileRulePaths.some(
      (path) => store.match(fileRuleToolName, path, [canonicalName, ...aliasNames]) === behavior,
    );
  const fileRuleDenied = matchesFileRule("deny");
  const fileRuleAsked = matchesFileRule("ask");
  if (matched === "deny" || fileRuleDenied || fieldDenyRule !== null) return "deny";
  const hasRuleAsk = matched === "ask" || fileRuleAsked || fieldAskRule !== null;
  const planContext = { sessionId: deps.agentDeps.session.id, cwd };
  if (!hasRuleAsk && call.name === "Write" && isActivePlanFileWrite(call.input, planContext))
    return "allow";
  if (!hasRuleAsk && isAutoMemoryEdit(call.name, call.input, cwd)) return "allow";
  if (permissionFree && !hasRuleAsk && !requiresUserInteraction) return "allow";
  // PERM-HOOK-ALLOW-BYPASS-001: a PreToolUse hook's explicit
  // hookSpecificOutput.permissionDecision:"allow" mirrors upstream's
  // resolveHookPermissionDecision -- it re-checks only the explicit deny/ask
  // rules just evaluated above and, finding none, resolves straight to allow,
  // bypassing the interactive/headless/background-agent prompt path entirely
  // (askPermission / headlessAutoDeny / backgroundAgentAutoDeny below). A
  // requiresUserInteraction tool (e.g. AskUserQuestion) still owns its own
  // dialog and is excluded here, matching every other bypass above.
  const hookPermission = preToolUseHookPermissionSignal();
  if (hookPermission === "allow" && !hasRuleAsk && !requiresUserInteraction) return "allow";
  let compound: ReturnType<typeof compoundBashDecision> = null;
  const command = call.name === "Bash" ? bashCommandFromInput(call.input) : null;
  // Match upstream ordering: argv-level path safety runs after explicit Bash
  // deny/ask rules but before an allow rule, session grant, or permissive mode.
  const bashPathDecision =
    command === null ? null : bashWritePathDecision(command, cwd, additionalWorkingDirectories);
  const bashReadDecision =
    command === null ? null : bashReadPathDecision(command, cwd, additionalWorkingDirectories);
  const bashCdDecision =
    command === null ? null : bashCdPathDecision(command, cwd, additionalWorkingDirectories);
  const bashDangerousRmDecision = command === null ? null : bashDangerousRmRootVarDecision(command);
  const bashDangerousRmPathDecision =
    command === null
      ? null
      : bashDangerousRmCriticalPathDecision(command, cwd, additionalWorkingDirectories);
  const mode = currentPermissionMode(deps);
  // MCP-PLAN-001: plan mode keeps a write-shaped call bypass-immune to an
  // already-granted allow rule (persisted rule or session grant — both are
  // folded into `matched` above), mirroring upstream's mode:'plan' passthrough
  // rewrite for non-readonly MCP tools (permissions.ts:1730-1745) and the
  // filesystem write gate that runs before matchingAllowRuleForAllPaths
  // (filesystem.ts:2114). Only yolo (a distinct, mutually exclusive mode from
  // plan — see currentPermissionMode) ever lets such a call through; a Bash
  // allow rule for a non-filesystem-mutating command (e.g. `npm test:*`)
  // still auto-allows, since only recognized write commands are gated.
  const planModeWriteGate =
    mode === "plan" &&
    (isAcceptEditsTool(call.name) ||
      (command !== null && bashHasWriteCommand(command)) ||
      (isMcpToolName(call.name) && handler?.isConcurrencySafe !== true));
  if (matched !== "ask" && command !== null) {
    compound = compoundBashDecision(command, {
      matchSub: (sub) => store.match(canonicalName, sub, aliasNames),
      subSessionAllowed: () => false,
      subAutoAllowed: (sub) => isReadOnlyBashCommand(sub),
    });
    if (compound === "deny") return "deny";
    if (
      compound === "allow" &&
      !planModeWriteGate &&
      hookPermission !== "ask" &&
      bashPathDecision === null &&
      bashReadDecision === null &&
      bashCdDecision === null &&
      bashDangerousRmDecision === null &&
      bashDangerousRmPathDecision === null
    ) {
      return "allow";
    }
  }
  const mustAsk =
    hasRuleAsk ||
    compound === "rule-ask" ||
    bashDangerousRmDecision === "ask" ||
    bashDangerousRmPathDecision === "ask" ||
    // PERM-HOOK-ALLOW-BYPASS-001: a PreToolUse hook's explicit
    // hookSpecificOutput.permissionDecision:"ask" forces the interactive/
    // headless prompt path even when mode (including yolo) or a matched
    // allow rule would otherwise auto-allow, mirroring upstream's
    // resolveHookPermissionDecision forceDecision on "ask". An explicit deny
    // rule (checked above, before `hookPermission` is even read) still wins,
    // and a requiresUserInteraction tool still owns its own dialog instead of
    // this one (checked further below, unconditionally on `mustAsk`).
    hookPermission === "ask" ||
    (mode !== "yolo" &&
      (bashPathDecision === "ask" ||
        bashReadDecision === "ask" ||
        bashCdDecision === "ask" ||
        compound === "ask" ||
        !isSensitiveWriteApprovable(call.name, call.input, cwd, (path, base) =>
          filePathRepresentations(path, base ?? cwd, true),
        )));
  if (!mustAsk) {
    if (isWorkspaceRead(call.name, call.input, cwd, realpathSync, additionalWorkingDirectories))
      return "allow";
    if (call.name === "Bash" && isReadOnlyToolCheck(call.name, call.input)) return "allow";
    if (matched === "allow" && !requiresUserInteraction && !planModeWriteGate) return "allow";
    if (mode === "yolo" && !requiresUserInteraction) return "allow";
    if (mode === "accept-edits") {
      if (isWorkspaceEdit(call.name, call.input, cwd, additionalWorkingDirectories)) return "allow";
      if (
        command !== null &&
        isAcceptEditsBashInWorkingDirectories(command, cwd, additionalWorkingDirectories)
      )
        return "allow";
    }
  }
  const agentContext = getAgentContext();
  // AGENT-PERM-003: a detached named background subagent has no parent turn
  // of its own to answer a prompt, but in an interactive TUI session the
  // permission channel is a session-long duplex the REPL is already
  // subscribed to (mirroring upstream's hasRequestDialog check in
  // runAgent.ts, which only auto-avoids prompts when there is no live
  // request dialog bound). So auto-deny only when there is no live UI to
  // bubble the ask to; a headless/print or piped run still auto-denies.
  if (agentContext?.shouldAvoidPermissionPrompts === true && getRuntimeKind() !== "interactive")
    return backgroundAgentAutoDeny(call);
  if (getRuntimeKind() === "print") return headlessAutoDeny(deps, call);
  // AskUserQuestion owns the interactive dialog. It must still reach the
  // headless and no-prompt guards above, but does not need a second generic
  // permission approval before showing that dialog.
  if (!hasRuleAsk && requiresUserInteraction) return "allow";
  const suggestions =
    canonicalName === "Read"
      ? filesystemReadSessionSuggestions(filePath, cwd, additionalWorkingDirectories)
      : [];
  const result = await askPermission(
    {
      toolName: call.name,
      argsPreview,
      rule: permissionPattern,
      input: call.input,
      readOnly: isReadOnlyToolCheck(call.name, call.input),
      editDirectory: outsideEditDirectory(call.name, call.input, cwd, additionalWorkingDirectories),
      ...(suggestions.length > 0 ? { suggestions } : {}),
      ...(agentContext
        ? { source: { name: agentContext.subagentName, depth: agentContext.depth } }
        : {}),
    },
    signal,
  );
  const feedback = result.feedback?.trim();
  if (result.decision === "deny") {
    // Feedback typed on a rejection rides the denial itself so the model can
    // adjust immediately, instead of waiting a turn for an injection to drain.
    if (feedback && feedback.length > 0) {
      return {
        kind: "deny",
        message: `permission denied\nThe user rejected this tool call with feedback: ${feedback}`,
      };
    }
    return "deny";
  }
  for (const update of result.updates) {
    await applyUpdate(deps, update, { rules, cwd });
  }
  // Feedback typed on an approval arrives after the tool result, at the next
  // continuation boundary — same queue the plan feedback uses.
  if (feedback && feedback.length > 0) {
    deps.injections.push(`[user-feedback-on-tool-approval]\n${feedback}`);
  }
  return result.decision;
}

async function resolveExitPlanMode(
  deps: PermissionResolutionDeps,
  call: ToolCall,
  signal: AbortSignal | undefined,
): Promise<PermissionDecision> {
  if (currentPermissionMode(deps) !== "plan") {
    return {
      kind: "deny",
      message:
        "ExitPlanMode is only valid while in plan mode. If your plan was already approved, continue with the implementation instead.",
    };
  }
  if (getRuntimeKind() === "print") return await headlessAutoDeny(deps, call);
  const result = await askPermission(
    {
      toolName: call.name,
      argsPreview: previewArgs(call.input),
      rule: null,
      input: call.input,
      bypassAvailable: deps.agentDeps.broker.read().prePlanMode === "yolo",
    },
    signal,
  );
  if (result.decision === "allow") {
    for (const update of result.updates) {
      await applyUpdate(deps, update, { rules: [], cwd: deps.agentDeps.session.cwd });
    }
    return "allow";
  }
  const feedback = result.feedback?.trim();
  if (feedback && feedback.length > 0) {
    deps.injections.push(`[user-feedback-on-plan]\n${feedback}`);
    return {
      kind: "deny",
      message: `User rejected the plan with this feedback: ${feedback}\nUpdate the plan to address it and call ExitPlanMode again.`,
    };
  }
  return {
    kind: "deny",
    message:
      "User wants to revise the plan. Wait for them to describe the changes they want, then update the plan and call ExitPlanMode again.",
  };
}

interface ApplyContext {
  rules: PermissionRule[];
  cwd: string;
}

async function applyUpdate(
  deps: PermissionResolutionDeps,
  update: PermissionUpdate,
  ctx: ApplyContext,
): Promise<void> {
  if (update.type === "setMode") {
    const mode = mapMode(update.mode);
    if (!mode) return;
    const currentMode = currentPermissionMode(deps);
    if (mode === "accept-edits" && currentMode !== "default" && currentMode !== "plan") return;
    deps.agentDeps.broker.dispatch({ kind: "set_permission_mode", mode });
    return;
  }
  if (update.type === "addDirectories") {
    const directories = activeAdditionalWorkingDirectories(deps);
    const added: string[] = [];
    for (const directory of update.dirs) {
      const canonical = canonicalizeWorkingDirectory(directory, ctx.cwd);
      if (canonical === null) continue;
      directories.add(canonical);
      added.push(canonical);
    }
    await persistAdditionalDirectoryUpdate(added, update.destination ?? "session", ctx.cwd, false);
    return;
  }
  if (update.type === "removeDirectories") {
    const directories = activeAdditionalWorkingDirectories(deps);
    const removed = update.dirs.map((directory) => resolveWorkingDirectory(directory, ctx.cwd));
    for (const directory of removed) directories.delete(directory);
    await persistAdditionalDirectoryUpdate(removed, update.destination ?? "session", ctx.cwd, true);
    return;
  }
  if (update.type === "addRules") {
    if (update.destination === "session") {
      const sessionAllowed = activeSessionAllowSet(deps);
      for (const rule of update.rules) {
        if (rule.ruleBehavior !== "allow") continue;
        sessionAllowed.add(permissionRuleValueToString(rule.ruleValue));
      }
      return;
    }
    const next = mergeRules(ctx.rules, update.rules);
    if (next.length > ctx.rules.length) {
      await saveRules(next, ctx.cwd);
    }
    return;
  }
  if (update.type === "removeRules") {
    if (update.source === "session") {
      const sessionAllowed = activeSessionAllowSet(deps);
      for (const rule of update.rules) {
        if (rule.ruleBehavior !== "allow") continue;
        sessionAllowed.delete(permissionRuleValueToString(rule.ruleValue));
      }
      return;
    }
    // Only the editable settings files can have rules removed here. Policy,
    // flag, CLI-arg, command, and toolsNarrowing sources are immutable at
    // this layer, matching upstream's `supportsPersistence` restriction to
    // localSettings/userSettings/projectSettings.
    if (
      update.source !== "userSettings" &&
      update.source !== "projectSettings" &&
      update.source !== "localSettings"
    ) {
      return;
    }
    const next = removeRulesFromCollection(ctx.rules, update.source, update.rules);
    if (next.length < ctx.rules.length) {
      await saveRules(next, ctx.cwd);
    }
  }
}

function mapMode(
  raw: "default" | "accept-edits" | "plan" | "yolo" | "dontAsk",
): PermissionMode | null {
  if (raw === "yolo" || raw === "accept-edits" || raw === "plan" || raw === "default") return raw;
  return null;
}

function mergeRules(existing: PermissionRule[], added: PermissionRule[]): PermissionRule[] {
  const out = [...existing];
  for (const rule of added) {
    const dup = out.some(
      (r) =>
        r.source === rule.source &&
        r.ruleBehavior === rule.ruleBehavior &&
        r.ruleValue.toolName === rule.ruleValue.toolName &&
        (r.ruleValue.ruleContent ?? "") === (rule.ruleValue.ruleContent ?? ""),
    );
    if (!dup) out.push(rule);
  }
  return out;
}

// Mirrors mergeRules' identity (source + behavior + toolName + ruleContent)
// so a rule added and removed through this same normalization always
// round-trips. Only rules matching `source` are eligible for removal; other
// sources' rules pass through untouched.
function removeRulesFromCollection(
  existing: PermissionRule[],
  source: PermissionRule["source"],
  toRemove: PermissionRule[],
): PermissionRule[] {
  return existing.filter((r) => {
    if (r.source !== source) return true;
    return !toRemove.some(
      (rule) =>
        rule.ruleBehavior === r.ruleBehavior &&
        rule.ruleValue.toolName === r.ruleValue.toolName &&
        (rule.ruleValue.ruleContent ?? "") === (r.ruleValue.ruleContent ?? ""),
    );
  });
}
