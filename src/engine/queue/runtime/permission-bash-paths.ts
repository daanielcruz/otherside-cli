import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { isReadOnlyBashCommand } from "@/engine/tools/_infra/command-analysis/read-only.ts";
import {
  containsUnsafeRedirect,
  stripLeadingSafeEnvVars,
  stripSafeWrappers,
  tokenizeRespectingQuotes,
} from "@/kernel/permissions/bash-matcher.ts";
import { isSensitiveFilePath, splitBashSubcommands } from "@/kernel/permissions/sensitive-paths.ts";
import { startsWithDir } from "@/kernel/std/fs/paths.ts";
import {
  absoluteFilePath,
  directoryForPath,
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

/** A segment whose command is `cd`. */
export function isDirectoryChange(segment: string): boolean {
  return /^cd(?:\s|$)/.test(segment.trim());
}

// Shell/runtime expansions and write globs cannot be resolved before the command
// runs, so they must never be authorized by a saved Bash rule or directory grant.
function isUnresolvableWritePath(filePath: string): boolean {
  return (
    filePath.includes("$") ||
    filePath.includes("%") ||
    filePath.startsWith("=") ||
    (filePath.startsWith("~") && filePath !== "~" && !filePath.startsWith("~/")) ||
    /[*?[\]{}]/.test(filePath)
  );
}

export function bashWritePathDecision(
  command: string,
  cwd: string,
  additionalWorkingDirectories: Iterable<string>,
): "ask" | null {
  const segments = commandSegments(command);
  const compoundHasCd = segments.length > 1 && segments.some(isDirectoryChange);
  for (const segment of segments) {
    const write = bashWritePaths(segment);
    if (!write) continue;
    // Fail closed on cp/mv flags: --target-directory and
    // similar options can carry a destination outside the positional argv.
    if (write.hasUnsupportedFlags || compoundHasCd) return "ask";
    for (const filePath of write.paths) {
      if (isUnresolvableWritePath(filePath)) return "ask";
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

/**
 * Whether a command does nothing but file writes a grant already covers: every
 * segment writes through a file command, and every operand names a path known before
 * the command runs that `covered` accepts. The file rules hold for Bash as they do for
 * the Edit tools, so a directory opened for edits takes these writes too.
 */
export function bashWritesCovered(
  command: string,
  covered: (filePath: string) => boolean,
): boolean {
  const segments = commandSegments(command);
  return segments.length > 0 && segments.every((segment) => segmentWritesCovered(segment, covered));
}

function segmentWritesCovered(segment: string, covered: (filePath: string) => boolean): boolean {
  if (containsUnsafeRedirect(segment)) return false;
  const write = bashWritePaths(segment);
  if (write === null || write.hasUnsupportedFlags || write.paths.length === 0) return false;
  return write.paths.every((filePath) => !isUnresolvableWritePath(filePath) && covered(filePath));
}

/**
 * The directories a lasting approval of a command's file writes opens: where each
 * write `covered` does not already allow lands. Null when a write cannot be granted
 * ahead of time — its target is only known once the command runs, a flag can carry
 * it elsewhere, a `cd` moves it, or it touches a sensitive path — so the next run
 * would ask again whatever was saved.
 */
export function bashWriteGrantDirectories(
  command: string,
  cwd: string,
  covered: (filePath: string) => boolean,
): string[] | null {
  const segments = commandSegments(command);
  const compoundHasCd = segments.length > 1 && segments.some(isDirectoryChange);
  const directories = new Set<string>();
  for (const segment of segments) {
    const write = bashWritePaths(segment);
    if (write === null) continue;
    if (write.hasUnsupportedFlags || compoundHasCd) return null;
    for (const filePath of write.paths) {
      if (isUnresolvableWritePath(filePath)) return null;
      if (
        filePathRepresentations(filePath, cwd, true).some((path) => isSensitiveFilePath(path, cwd))
      )
        return null;
      if (covered(filePath)) continue;
      directories.add(directoryForPath(absoluteFilePath(filePath, cwd)));
    }
  }
  return [...directories];
}

function commandSegments(command: string): string[] {
  return splitBashSubcommands(command)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Where a command's `cd` segments lead, as absolute directories, or null when a
 * destination cannot be known before the command runs (globs, `$VAR`, unparseable
 * wrappers) — the command then asks rather than track an effective directory.
 */
function cdDestinations(command: string, cwd: string): string[] | null {
  const destinations: string[] = [];
  for (const segment of splitBashSubcommands(command)) {
    const trimmed = segment.trim();
    if (!isDirectoryChange(trimmed)) continue;
    const tokens = unwrapBashPathWrappers(tokenizeRespectingQuotes(trimmed));
    if (tokens === null || tokens[0] !== "cd") return null;
    const args = tokens.slice(1);
    const destination = args.length === 0 ? homedir() : args.join(" ");
    if (
      destination.includes("$") ||
      destination.includes("%") ||
      destination.startsWith("=") ||
      (destination.startsWith("~") && destination !== "~" && !destination.startsWith("~/")) ||
      /[*?[\]{}]/.test(destination)
    )
      return null;
    destinations.push(absoluteFilePath(destination, cwd));
  }
  return destinations;
}

/**
 * The paths a command's read-only segments read and its write segments write: each
 * operand as typed, so a rule written the same way matches, plus its absolute forms.
 */
export interface BashPathOperands {
  reads: string[];
  writes: string[];
}

/**
 * Every path a command reads or writes, resolved against each directory the command
 * may run in: the working directory and any `cd` destination in it. A relative
 * operand after `cd <dir>` resolves there at runtime, so it is checked in both places.
 * Write operands whose target cannot be known before the command runs are left out;
 * the write check asks for those.
 */
export function bashPathOperands(command: string, cwd: string): BashPathOperands {
  const bases = [cwd, ...(cdDestinations(command, cwd) ?? [])];
  const resolved = (filePath: string): string[] =>
    isAbsolute(expandHome(filePath))
      ? [filePath, absoluteFilePath(filePath, cwd)]
      : [filePath, ...bases.map((base) => absoluteFilePath(filePath, base))];
  const reads = new Set<string>();
  const writes = new Set<string>();
  for (const segment of splitBashSubcommands(command)) {
    if (isReadOnlyBashCommand(segment)) {
      for (const filePath of bashReadPaths(segment) ?? []) {
        for (const path of resolved(filePath)) reads.add(path);
      }
    }
    for (const filePath of bashWritePaths(segment)?.paths ?? []) {
      if (isUnresolvableWritePath(filePath)) continue;
      for (const path of resolved(filePath)) writes.add(path);
    }
  }
  return { reads: [...reads], writes: [...writes] };
}

/**
 * The paths a command reads outside the workspace that no Read allow rule covers;
 * any of them makes the call ask. Every read-only segment is checked on its own:
 * another segment an allow rule covers must not let `npm test && cat ~/.ssh/config`
 * read outside unasked.
 */
export function bashBlockedReadPaths(
  command: string,
  cwd: string,
  additionalWorkingDirectories: Iterable<string>,
  readAllowed: (filePath: string) => boolean,
): string[] {
  return bashPathOperands(command, cwd).reads.filter(
    (filePath) =>
      !pathWithinWorkspace(filePath, cwd, realpathSync, additionalWorkingDirectories) &&
      !readAllowed(filePath),
  );
}

/**
 * The `cd` destinations outside the workspace that no Read allow rule opens, or null
 * when a destination cannot be known. Either makes the call ask: every later relative
 * operand resolves in that directory at runtime, so leaving the workspace needs the
 * user unless they already opened the directory for reading. A bare `cd <outside>` is
 * checked the same way as one inside a compound.
 */
export function bashBlockedCdDirectories(
  command: string,
  cwd: string,
  additionalWorkingDirectories: Iterable<string>,
  readAllowed: (filePath: string) => boolean,
): string[] | null {
  const destinations = cdDestinations(command, cwd);
  if (destinations === null) return null;
  return destinations.filter(
    (directory) =>
      !pathWithinWorkspace(directory, cwd, realpathSync, additionalWorkingDirectories) &&
      !readAllowed(directory),
  );
}
