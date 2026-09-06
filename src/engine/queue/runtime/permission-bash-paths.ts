import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { isReadOnlyBashCommand } from "@/engine/tools/_infra/command-analysis/read-only.ts";
import {
  stripLeadingSafeEnvVars,
  stripSafeWrappers,
  tokenizeRespectingQuotes,
} from "@/kernel/permissions/bash-matcher.ts";
import { isSensitiveFilePath, splitBashSubcommands } from "@/kernel/permissions/sensitive-paths.ts";
import { startsWithDir } from "@/kernel/std/fs/paths.ts";
import {
  expandHome,
  filePathRepresentations,
  pathWithinWorkspace,
} from "./permission-workspace.ts";

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

export interface BashWritePaths {
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

export function bashWritePaths(segment: string): BashWritePaths | null {
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

export function bashWritePathDecision(
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
    // Fail closed on cp/mv flags: --target-directory and
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
// intentionally NOT treated as writes here: an explicit
// Bash allow rule for a non-filesystem command still auto-allows in plan
// mode.
export function bashHasWriteCommand(command: string): boolean {
  return splitBashSubcommands(command)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .some((segment) => bashWritePaths(segment) !== null);
}

// Root-var expansion pattern: an `rm`/
// `rmdir` target that is a bare $VAR or ${VAR} expansion directly followed by
// `/` and a glob, another expansion, another slash, or the end of the
// argument expands to the filesystem root (or a top-level directory) when the
// variable is unset or empty at runtime — e.g. `rm -rf $UNSET/*` becomes
// `rm -rf /*`. Quotes around the expansion (`"$UNSET"/`) are already stripped
// by tokenizeRespectingQuotes before this runs, so this regex doesn't need to
// match quote characters itself.
const DANGEROUS_RM_ROOT_VAR_RE =
  /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)\/(?:[*$/]|$)/;

// This one pattern stays bypass-immune even while a Bash call is
// otherwise auto-allowed by an allow rule or by yolo/accept-edits mode
// (the "Dangerous rm operation"/"Dangerous rmdir operation" ask is
// re-returned even when bypass is set). So — unlike the rest of
// bashWritePathDecision, whose "ask" is gated by `mode !== "yolo"` below —
// this check must be OR'd into `mustAsk` unconditionally.
export function bashDangerousRmRootVarDecision(command: string): "ask" | null {
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

// Dangerous-removal / working-path check: a
// path that IS the filesystem root, the user's home directory, or a direct
// child of root (e.g. `/usr`, `/etc`) is a catastrophic rm/rmdir target on
// its own; a path that is a tracked working directory (session cwd or an
// additionalWorkingDirectory) — or an ancestor of one, since removing the
// ancestor removes the working directory with it — is equally catastrophic.
// This intentionally compares the plain (lexical) resolved path rather than a
// symlink-realpath'd one: a plain path-segment check, and
// avoiding a real filesystem quirk (e.g. macOS resolving `/etc` to
// `/private/etc`) silently moving a genuine direct-child-of-root target out
// from under the "direct child of root" shape.
function isCriticalSystemDirectory(absolutePath: string, homeDir: string): boolean {
  const parent = dirname(absolutePath);
  if (parent === absolutePath) return true; // filesystem root itself
  if (dirname(parent) === parent) return true; // direct child of root
  return absolutePath === homeDir;
}

// The dangerous-removal check runs ahead of any allow rule and stays
// bypass-immune even while yolo is set — the "Dangerous rm/rmdir operation"
// ask reason is re-returned by the narrow dangerous-rm exception regardless
// of bypass state.
// Like bashDangerousRmRootVarDecision above (a distinct, narrower
// pattern for unresolved `$VAR/` expansions), this must be OR'd into
// `mustAsk` unconditionally, never gated by `mode !== "yolo"`.
export function bashDangerousRmCriticalPathDecision(
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

export function bashReadPathDecision(
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
// `cd <outside>` and any compound containing it are covered — the cd target
// is validated for every Bash call, not only compounds. Multiple `cd`s or
// unresolvable destinations
// (globs, `$VAR`, unparseable wrappers) fail closed to "ask" rather than
// attempt to track an effective cwd across segments.
export function bashCdPathDecision(
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
