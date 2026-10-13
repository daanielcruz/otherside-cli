import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, relative, resolve, sep, win32 } from "node:path";
import type { RuleSourceScope } from "@/kernel/permissions/types.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";

/** Tools whose rules name file paths: `Read` for reading, `Edit` for every tool that writes. */
export const PATH_RULE_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/** The directories a file rule's pattern can anchor to. */
export interface PathRuleRoots {
  /** Relative patterns, and `/` in a project, local, policy, session or command-line rule. */
  cwd: string;
  /** `/` in a user-settings rule. */
  userSettingsRoot: string;
  /** `/` in a rule from a settings file passed on the command line. */
  flagSettingsRoot: string;
}

export function pathRuleRoots(cwd: string): PathRuleRoots {
  const flagSettings = process.env.OTHERSIDE_FLAG_SETTINGS;
  return {
    cwd,
    userSettingsRoot: configRoot(),
    flagSettingsRoot: flagSettings ? dirname(resolve(flagSettings)) : cwd,
  };
}

interface AnchoredPattern {
  root: string;
  pattern: string;
}

/**
 * Where a file rule's pattern is anchored, by its prefix:
 * `//path` from the filesystem root, `~/path` from the home directory, `/path` from
 * the root of the settings the rule came from, anything else (with or without `./`)
 * from the working directory.
 */
export function anchorPathPattern(
  pattern: string,
  source: RuleSourceScope,
  roots: PathRuleRoots,
): AnchoredPattern {
  if (pattern.startsWith("//")) return driveAnchored(pattern.slice(1));
  if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(pattern)) {
    const rest = pattern.slice(3).replaceAll("\\", "/");
    return { root: `${pattern[0]?.toUpperCase()}:\\`, pattern: `/${rest}` };
  }
  if (pattern === "~" || pattern.startsWith("~/")) {
    return { root: homedir().normalize("NFC"), pattern: pattern.slice(1) || "/" };
  }
  if (pattern.startsWith("/")) return { root: settingsRoot(source, roots), pattern };
  return { root: roots.cwd, pattern: pattern.startsWith("./") ? pattern.slice(2) : pattern };
}

// On Windows `//c/Users/...` names the `C:` drive; everywhere else `//` is the root.
function driveAnchored(rooted: string): AnchoredPattern {
  const drive = process.platform === "win32" ? /^\/([A-Za-z])(\/|$)/.exec(rooted) : null;
  if (drive?.[1]) {
    return { root: `${drive[1].toUpperCase()}:\\`, pattern: rooted.slice(2) || "/" };
  }
  return { root: "/", pattern: rooted };
}

function settingsRoot(source: RuleSourceScope, roots: PathRuleRoots): string {
  if (source === "userSettings") return roots.userSettingsRoot;
  if (source === "flagSettings") return roots.flagSettingsRoot;
  return roots.cwd;
}

/** Whether a file rule's pattern covers a path, which may be relative to the working directory. */
export function pathRuleMatches(
  pattern: string,
  source: RuleSourceScope,
  path: string,
  roots: PathRuleRoots,
): boolean {
  const anchored = anchorPathPattern(pattern, source, roots);
  const within = relative(anchored.root, absolutePath(path, roots.cwd)).split(sep).join("/");
  if (within === "" || within === ".." || within.startsWith("../") || isAbsolute(within)) {
    return false;
  }
  return patternCovers(anchored.pattern, within);
}

function absolutePath(path: string, cwd: string): string {
  const expanded =
    path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  return resolve(cwd, expanded);
}

/**
 * Whether a gitignore-style pattern covers a root-relative path: the path itself or a
 * directory above it matches. A pattern without a slash matches at any depth; one with
 * a slash at its start or middle matches from the root only. A trailing `/**` covers the
 * directory and everything in it.
 */
function patternCovers(pattern: string, path: string): boolean {
  let body = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
  if (body.endsWith("/")) body = body.slice(0, -1);
  const fromRoot = body.includes("/");
  if (body.startsWith("/")) body = body.slice(1);
  if (body.length === 0) return true;
  const anyDepth = fromRoot ? "" : "(?:.*/)?";
  return new RegExp(`^${anyDepth}${globSource(body)}(?:/.*)?$`, "s").test(path);
}

function globSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "\\" && i + 1 < glob.length) {
      i++;
      out += escapeRegex(glob[i] as string);
    } else if (ch === "*" && glob[i + 1] === "*") {
      const leadsSegment = i === 0 || glob[i - 1] === "/";
      if (leadsSegment && glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i++;
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[" && glob.indexOf("]", i + 2) > i) {
      const close = glob.indexOf("]", i + 2);
      const members = glob
        .slice(i + 1, close)
        .replace(/^!/, "^")
        .replaceAll("\\", "\\\\");
      out += `[${members}]`;
      i = close;
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

function escapeRegex(ch: string): string {
  return /[.+^${}()|[\]\\*?]/.test(ch) ? `\\${ch}` : ch;
}

/** A path written into a rule so glob characters in it stay literal. */
function literalPattern(path: string): string {
  return path.replaceAll("\\", "\\\\").replace(/[*?[\]]/g, (ch) => `\\${ch}`);
}

/** An absolute path as the rule that names it wherever the rule is saved (`//abs/path`). */
function absolutePattern(absolute: string): string {
  if (process.platform === "win32" && win32.isAbsolute(absolute)) {
    const drive = absolute[0]?.toLowerCase() ?? "c";
    const rest = absolute.slice(2).replaceAll("\\", "/").replace(/\/+$/, "");
    return `//${drive}${literalPattern(rest)}`;
  }
  return `/${literalPattern(absolute)}`;
}

/** The rule that names one file, anchored so it means the same in any settings file. */
export function filePathPattern(filePath: string): string {
  return isAbsolute(filePath) ? absolutePattern(filePath) : literalPattern(filePath);
}

/** The rule that names a directory and everything in it (`//abs/dir/**`). */
export function directoryPathPattern(directory: string): string {
  const rootLen = parse(directory).root.length;
  const trimmed =
    directory.length > Math.max(1, rootLen) && directory.endsWith(sep)
      ? directory.slice(0, -1)
      : directory;
  return `${absolutePattern(trimmed)}/**`;
}

/**
 * A rule saved before file rules were anchored named an absolute path with one leading
 * slash, which anchored now reads from the settings root. Such a rule, when the directory
 * it starts with exists at the filesystem root, is rewritten to the absolute form it
 * always meant.
 */
export function anchoredLegacyPattern(pattern: string): string {
  if (!pattern.startsWith("/") || pattern.startsWith("//")) return pattern;
  const top = pattern.slice(1).split("/", 1)[0] ?? "";
  if (top.length === 0 || /[*?[\]\\]/.test(top)) return pattern;
  try {
    return statSync(`/${top}`).isDirectory() ? `/${pattern}` : pattern;
  } catch {
    return pattern;
  }
}
