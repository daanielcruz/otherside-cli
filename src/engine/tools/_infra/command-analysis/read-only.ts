import { containsUnsafeRedirect } from "@/kernel/permissions/bash-matcher.ts";
import { splitCommandParts } from "./commands.ts";
import { isReadOnlySedInvocation } from "./sed-read-only.ts";
import { tokenizeSegment, unquote } from "./shell-tokens.ts";

// Read-only Bash classifier — the gate that lets safe inspection commands run
// without a permission prompt.
//
// FAIL CLOSED: returns true ONLY when the command is provably read-only — every
// pipeline stage's base command is known-safe and its flags are validated. Any
// command, flag, redirect, substitution, or expansion we cannot prove harmless
// returns false, falling back to the normal permission prompt. A too-narrow
// allowlist only costs a prompt; it never opens a hole. Validation is per-FLAG,
// never per-name: a name set alone is exploitable (`find -exec`, `rg --pre`,
// `sort -o`, `sed -i` all start with an otherwise-safe command).

// Commands that cannot write files, execute code, or open the network under ANY
// flag or positional argument — read-only regardless of how they are invoked.
const ALWAYS_READ_ONLY: ReadonlySet<string> = new Set([
  // file content / metadata viewers
  "cat",
  "head",
  "nl",
  "stat",
  "file",
  "strings",
  "od",
  "hexdump",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  // listing / search (no write or exec flag exists)
  "ls",
  "grep",
  "egrep",
  "fgrep",
  // text transforms to stdout
  "cut",
  "paste",
  "tr",
  "column",
  "tac",
  "rev",
  "fold",
  "expand",
  "unexpand",
  "fmt",
  "pr",
  "comm",
  "cmp",
  "diff",
  "wc",
  // checksums (read + compute only)
  "sha256sum",
  "sha1sum",
  "md5sum",
  "cksum",
  // structured-data query to stdout (no write or exec mode)
  "jq",
  // system info (no mutating positional)
  "pwd",
  "whoami",
  "id",
  "uname",
  "nproc",
  "groups",
  "arch",
  "tty",
  "cal",
  "uptime",
  "locale",
  "getconf",
  "tsort",
  "du",
  "df",
  // shell-neutral
  "echo",
  "printf",
  "true",
  "false",
  "which",
  "type",
  "seq",
  "test",
  "[",
  "expr",
]);

type SubcommandGuard = (args: string[]) => boolean;

function blocksAnyFlag(args: string[], isBlocked: (token: string) => boolean): boolean {
  return args.some((raw) => {
    const token = unquote(raw);
    const name = token.split("=")[0] ?? token;
    return isBlocked(token) || isBlocked(name);
  });
}

const FIND_WRITE_OR_EXEC_FLAGS: ReadonlySet<string> = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

const RG_EXEC_FLAGS: ReadonlySet<string> = new Set(["--pre", "--pre-glob", "--hostname-bin"]);

// git subcommands that only ever inspect — no write/exec/network mode exists for
// them (their per-invocation write/exec flags are screened by GIT_WRITE_OR_EXEC).
const GIT_ALWAYS_READ_ONLY: ReadonlySet<string> = new Set([
  "status",
  "log",
  "show",
  "diff",
  "blame",
  "grep",
  "shortlog",
  "whatchanged",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "cat-file",
  "for-each-ref",
  "name-rev",
  "merge-base",
  "show-ref",
  "describe",
  "var",
  "count-objects",
  "cherry",
]);

// Global (pre-subcommand) options that relocate where git finds code or config —
// each can turn an inspection command into arbitrary execution, so any one in the
// global position fails the check.
const GIT_RELOCATING_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "-c",
  "-C",
  "--exec-path",
  "--config-env",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

// Per-invocation flags that make an otherwise-read-only git command write a file
// or run a configured program (external diff/textconv/filter drivers, grep pager).
const GIT_WRITE_OR_EXEC_FLAGS: ReadonlySet<string> = new Set([
  "--output",
  "--ext-diff",
  "--textconv",
  "--filters",
  "--open-files-in-pager",
]);

const GIT_BRANCH_MUTATING: ReadonlySet<string> = new Set([
  "-d",
  "-D",
  "-m",
  "-M",
  "-c",
  "-C",
  "-f",
  "-u",
  "--delete",
  "--move",
  "--copy",
  "--force",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
]);

const GIT_TAG_MUTATING: ReadonlySet<string> = new Set([
  "-a",
  "-s",
  "-m",
  "-d",
  "-f",
  "-F",
  "--annotate",
  "--sign",
  "--message",
  "--file",
  "--delete",
  "--force",
  "--create-reflog",
]);

const GIT_CONFIG_READ_FLAGS: ReadonlySet<string> = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
  "-l",
]);

const GIT_CONFIG_WRITE_FLAGS: ReadonlySet<string> = new Set([
  "--add",
  "--unset",
  "--unset-all",
  "--replace-all",
  "--rename-section",
  "--remove-section",
  "-e",
  "--edit",
]);

function gitBareArgs(args: string[]): string[] {
  return args.filter((raw) => !unquote(raw).startsWith("-"));
}

function gitHasFlag(args: string[], flags: ReadonlySet<string>): boolean {
  return blocksAnyFlag(args, (token) => flags.has(token));
}

// Base command → guard validating that THIS invocation stays read-only. A guard
// runs only after the global substitution/redirect checks pass.
const GUARDED: Readonly<Record<string, SubcommandGuard>> = {
  // tail without -f is read-only; -f/-F would block forever (hang, not a write).
  tail: (args) => !blocksAnyFlag(args, (t) => t === "-f" || t === "-F" || t === "--follow"),
  // find is read-only unless it can exec or write.
  find: (args) => !blocksAnyFlag(args, (t) => FIND_WRITE_OR_EXEC_FLAGS.has(t)),
  // ripgrep can execute a preprocessor (--pre) — everything else only reads.
  rg: (args) => !blocksAnyFlag(args, (t) => RG_EXEC_FLAGS.has(t)),
  // sort -o / --output writes a file; otherwise read-only (common in pipes).
  sort: (args) =>
    !args.some((raw) => {
      const t = unquote(raw);
      return /^-[a-z]*o/i.test(t) || t === "--output" || t.startsWith("--output=");
    }),
  // uniq's second positional is an OUTPUT file; allow at most one (the input).
  uniq: (args) => args.filter((raw) => !unquote(raw).startsWith("-")).length <= 1,
  // date prints unless it SETS the clock (-s/--set, a privileged write).
  date: (args) => !blocksAnyFlag(args, (t) => t === "-s" || t === "--set"),
  // tree prints the listing unless -o redirects it into a file.
  tree: (args) => !blocksAnyFlag(args, (t) => t === "-o"),
  // hostname prints the name unless it SETS it: any positional argument sets the
  // hostname, and -b/--boot / -F/--file / -y/--yp/--nis set it from another
  // source. Only display flags (-f/-s/-i/-I/-a/-d/-A/…) keep it read-only.
  hostname: (args) =>
    !args.some((raw) => !unquote(raw).startsWith("-")) &&
    !blocksAnyFlag(
      args,
      (t) =>
        t === "-b" ||
        t === "--boot" ||
        t === "-F" ||
        t === "--file" ||
        t === "-y" ||
        t === "--yp" ||
        t === "--nis",
    ),
  // git is read-only only for an explicit inspection allowlist, with no global
  // relocation and no per-invocation write/exec flag (see isReadOnlyGitInvocation).
  git: (args) => isReadOnlyGitInvocation(args),
  // sed only in two provably-safe shapes — print-only -n and single s/// to
  // stdout; the script is parsed and w/W/e + -i gated (see sed-read-only.ts).
  sed: (args) => isReadOnlySedInvocation(args),
};

function gitArgvSafe(rest: string[]): boolean {
  if (gitHasFlag(rest, GIT_WRITE_OR_EXEC_FLAGS)) return false;
  // grep's `-O[pager]` / diff's `-O<orderfile>` — the glued short form launches
  // a program or reads an arbitrary order file; reject either, fail closed.
  return !rest.some((raw) => /^-O/.test(unquote(raw)));
}

function isReadOnlyGitConfig(rest: string[]): boolean {
  if (gitHasFlag(rest, GIT_CONFIG_WRITE_FLAGS)) return false;
  return gitHasFlag(rest, GIT_CONFIG_READ_FLAGS);
}

function isReadOnlyGitRemote(rest: string[]): boolean {
  if (rest.length === 0) return true;
  const head = unquote(rest[0] ?? "");
  // `remote show` reaches the network; only the local listings are read-only.
  return head === "-v" || head === "--verbose" || head === "get-url";
}

function gitSubcommandReadOnly(sub: string, rest: string[]): boolean {
  if (GIT_ALWAYS_READ_ONLY.has(sub)) return true;
  switch (sub) {
    case "branch":
      return !gitHasFlag(rest, GIT_BRANCH_MUTATING) && gitBareArgs(rest).length === 0;
    case "tag":
      return !gitHasFlag(rest, GIT_TAG_MUTATING) && gitBareArgs(rest).length === 0;
    case "config":
      return isReadOnlyGitConfig(rest);
    case "remote":
      return isReadOnlyGitRemote(rest);
    case "stash": {
      const head = unquote(rest[0] ?? "");
      return head === "list" || head === "show";
    }
    case "worktree":
      return unquote(rest[0] ?? "") === "list";
    case "reflog": {
      const head = unquote(rest[0] ?? "");
      return head === "" || head === "show";
    }
    case "symbolic-ref":
      return (
        !blocksAnyFlag(rest, (t) => t === "-d" || t === "--delete") && gitBareArgs(rest).length <= 1
      );
    default:
      return false;
  }
}

function isReadOnlyGitInvocation(args: string[]): boolean {
  let index = 0;
  for (; index < args.length; index++) {
    const token = unquote(args[index] ?? "");
    if (!token.startsWith("-")) break;
    if (GIT_RELOCATING_GLOBAL_FLAGS.has(token.split("=")[0] ?? token)) return false;
  }
  const sub = unquote(args[index] ?? "");
  if (sub.length === 0) return false;
  const rest = args.slice(index + 1);
  if (!gitArgvSafe(rest)) return false;
  return gitSubcommandReadOnly(sub, rest);
}

// Detects command substitution `$(…)` and backticks outside single quotes —
// both execute arbitrary code. `${VAR}` and `$((arith))` are not substitution
// and are left to the per-command expansion guard. Process substitution `<(`/
// `>(` is caught earlier by the redirect check (it contains `<`/`>`).
function hasCommandSubstitution(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle) continue;
    if (ch === "`") return true;
    if (ch === "$" && command[i + 1] === "(" && command[i + 2] !== "(") return true;
  }
  return false;
}

// Commands whose glob-expanded operands stay read-only no matter what the
// pattern matches: every member can only ever READ whatever paths the shell
// hands it (no write/exec flag can be smuggled in via a filename because the
// member's flags are still validated by its ALWAYS/GUARDED entry). Plan mode
// and the read-only auto-allow both lean on this: `ls src/*` or `cat *.json`
// must flow without a prompt, while a glob under any other command stays
// unknowable and prompts. Path containment for glob operands is enforced
// separately by the Bash read-path gate (lexical resolution against the
// workspace), so an out-of-workspace glob still prompts.
const GLOB_SAFE_READ_ONLY: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "grep",
  "egrep",
  "fgrep",
  "diff",
  "du",
  "df",
  "echo",
  "strings",
  "hexdump",
  "od",
  "nl",
  "cut",
  "column",
  "tr",
  "tac",
  "rev",
  "cmp",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "sha256sum",
  "sha1sum",
  "md5sum",
]);

// `$VAR`-style expansion is unknowable at approval time: it could become a
// dangerous flag or path we never validated. `$` expands inside double-quotes
// too; single-quoted text is literal. `$(`/backtick is handled by
// hasCommandSubstitution.
function containsDollarExpansion(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle) continue;
    if (ch === "$") {
      const next = command[i + 1] ?? "";
      // `{` covers `${VAR}` parameter expansion; `(` is command substitution,
      // handled separately by hasCommandSubstitution.
      if (/[A-Za-z_@*#?!${0-9-]/.test(next)) return true;
    }
  }
  return false;
}

// Glob characters outside all quotes expand at runtime. That is only
// acceptable for GLOB_SAFE_READ_ONLY bases (see above); any other command with
// an unquoted glob stays unclassified and falls back to the prompt.
function containsGlobExpansion(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (/[?*[\]]/.test(ch)) return true;
  }
  return false;
}

function isSubcommandReadOnly(part: string): boolean {
  const tokens = tokenizeSegment(part.trim());
  if (tokens.length === 0) return false;
  const base = unquote(tokens[0] ?? "");
  if (base.length === 0) return false;
  if (ALWAYS_READ_ONLY.has(base)) return true;
  const guard = GUARDED[base];
  if (guard) return guard(tokens.slice(1));
  return false;
}

function isGlobSafeSubcommand(part: string): boolean {
  const tokens = tokenizeSegment(part.trim());
  const base = unquote(tokens[0] ?? "");
  return GLOB_SAFE_READ_ONLY.has(base);
}

export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (hasCommandSubstitution(trimmed)) return false;
  if (containsDollarExpansion(trimmed)) return false;
  if (containsUnsafeRedirect(trimmed)) return false;
  const parts = splitCommandParts(trimmed);
  if (parts.length === 0) return false;
  if (!parts.every(isSubcommandReadOnly)) return false;
  // An unquoted glob is tolerated only when EVERY pipeline stage is a
  // glob-safe reader; a single non-glob-safe stage makes the whole command
  // unknowable (the expansion could feed it a flag or path never validated).
  if (containsGlobExpansion(trimmed)) return parts.every(isGlobSafeSubcommand);
  return true;
}
