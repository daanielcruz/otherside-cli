import { splitCommandParts } from "./commands.ts";

export type DestructiveCategory =
  | "git_reset_hard"
  | "git_force_push"
  | "git_clean_force"
  | "git_checkout_dot"
  | "git_restore_dot"
  | "git_stash_drop"
  | "git_branch_force_delete"
  | "git_no_verify"
  | "git_commit_amend"
  | "rm_recursive_force"
  | "rm_recursive"
  | "rm_force"
  | "sql_drop_truncate"
  | "sql_delete_from"
  | "kubectl_delete"
  | "terraform_destroy"
  | "dd_block_device"
  | "mkfs_block_device"
  | "rm_broad_target"
  | "chmod_broad_recursive";

export interface DestructiveMatch {
  category: DestructiveCategory;
  warning: string;
}

const REGEX_PATTERNS: { pattern: RegExp; category: DestructiveCategory; warning: string }[] = [
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    category: "git_reset_hard",
    warning: "Note: may discard uncommitted changes",
  },
  {
    pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/,
    category: "git_force_push",
    warning: "Note: may overwrite remote history",
  },
  {
    pattern: /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/,
    category: "git_clean_force",
    warning: "Note: may permanently delete untracked files",
  },
  {
    pattern: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    category: "git_checkout_dot",
    warning: "Note: may discard all working tree changes",
  },
  {
    pattern: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    category: "git_restore_dot",
    warning: "Note: may discard all working tree changes",
  },
  {
    pattern: /\bgit\s+stash[ \t]+(drop|clear)\b/,
    category: "git_stash_drop",
    warning: "Note: may permanently remove stashed changes",
  },
  {
    pattern: /\bgit\s+branch\s+(-D[ \t]|--delete\s+--force|--force\s+--delete)\b/,
    category: "git_branch_force_delete",
    warning: "Note: may force-delete a branch",
  },
  {
    pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/,
    category: "git_no_verify",
    warning: "Note: may skip safety hooks",
  },
  {
    pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/,
    category: "git_commit_amend",
    warning: "Note: may rewrite the last commit",
  },
  {
    pattern:
      /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/,
    category: "rm_recursive_force",
    warning: "Note: may recursively force-remove files",
  },
  {
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/,
    category: "rm_recursive",
    warning: "Note: may recursively remove files",
  },
  {
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/,
    category: "rm_force",
    warning: "Note: may force-remove files",
  },
  {
    pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    category: "sql_drop_truncate",
    warning: "Note: may drop or truncate database objects",
  },
  {
    pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i,
    category: "sql_delete_from",
    warning: "Note: may delete all rows from a database table",
  },
  {
    pattern: /\bkubectl\s+delete\b/,
    category: "kubectl_delete",
    warning: "Note: may delete Kubernetes resources",
  },
  {
    pattern: /\bterraform\s+destroy\b/,
    category: "terraform_destroy",
    warning: "Note: may destroy Terraform infrastructure",
  },
];

function matchRegexPatterns(command: string): DestructiveMatch | null {
  for (const entry of REGEX_PATTERNS) {
    if (entry.pattern.test(command)) {
      return { category: entry.category, warning: entry.warning };
    }
  }
  return null;
}

const HOME_TOKENS = ["$HOME", "${HOME}", "~", "${HOME:-}", "$XDG_DATA_HOME", "${XDG_DATA_HOME}"];
const BROAD_TARGETS = new Set(["/", "/*", "/**", ".", "./", "../", "..", "*"]);
const SAFE_RM_FLAGS = new Set(["-r", "-R", "-rf", "-Rf", "-rfv", "-rfd", "--recursive", "--force"]);
const HOME_DEPTH_LIMIT = 3;

function tokens(cmd: string): string[] {
  return cmd
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function looksLikeHomeWipe(arg: string): boolean {
  if (HOME_TOKENS.includes(arg)) return true;
  for (const t of HOME_TOKENS) {
    if (arg === `${t}/`) return true;
    if (arg.startsWith(`${t}/`) && arg.split("/").length <= HOME_DEPTH_LIMIT) return true;
  }
  return false;
}

function isRmDangerous(cmd: string): DestructiveMatch | null {
  const t = tokens(cmd);
  if (t.length === 0 || t[0] !== "rm") return null;
  const args = t.slice(1);
  const hasRecursive = args.some((a) => SAFE_RM_FLAGS.has(a) || /^-[a-zA-Z]*[rR]/.test(a));
  if (!hasRecursive) return null;
  const positional = args.filter((a) => !a.startsWith("-"));
  for (const target of positional) {
    if (BROAD_TARGETS.has(target)) {
      return {
        category: "rm_broad_target",
        warning: `Note: rm -rf of "${target}" may wipe a large portion of the filesystem`,
      };
    }
    if (looksLikeHomeWipe(target)) {
      return {
        category: "rm_broad_target",
        warning: `Note: rm -rf of "${target}" may wipe the user's home directory`,
      };
    }
  }
  return null;
}

function isDdDangerous(cmd: string): DestructiveMatch | null {
  const t = tokens(cmd);
  if (t.length === 0 || t[0] !== "dd") return null;
  for (const arg of t) {
    if (/^of=\/dev\/(sd[a-z]|nvme|disk|hd[a-z]|mmcblk|vd[a-z])/i.test(arg)) {
      return {
        category: "dd_block_device",
        warning: `Note: writing to "${arg}" may destroy data on a raw block device`,
      };
    }
  }
  return null;
}

function isMkfsDangerous(cmd: string): DestructiveMatch | null {
  const t = tokens(cmd);
  if (t.length === 0) return null;
  if (!/^mkfs(\.|$)/.test(t[0] ?? "")) return null;
  for (const arg of t.slice(1)) {
    if (/^\/dev\/(sd[a-z]|nvme|disk|hd[a-z]|mmcblk|vd[a-z])/i.test(arg)) {
      return {
        category: "mkfs_block_device",
        warning: `Note: formatting "${arg}" may destroy all data on a raw block device`,
      };
    }
  }
  return null;
}

function isChmodWipeDangerous(cmd: string): DestructiveMatch | null {
  const t = tokens(cmd);
  if (t.length === 0 || t[0] !== "chmod") return null;
  const args = t.slice(1);
  const recursive = args.some((a) => a === "-R" || a === "--recursive" || /^-[a-zA-Z]*R/.test(a));
  if (!recursive) return null;
  const positional = args.filter(
    (a) => !a.startsWith("-") && !/^[0-7]{3,4}$|^[ugoa]*[+=-]/.test(a),
  );
  for (const target of positional) {
    if (BROAD_TARGETS.has(target) || looksLikeHomeWipe(target)) {
      return {
        category: "chmod_broad_recursive",
        warning: `Note: chmod -R on "${target}" may change permissions across a large path`,
      };
    }
  }
  return null;
}

const EXTRA_DETECTORS: Array<(cmd: string) => DestructiveMatch | null> = [
  isRmDangerous,
  isDdDangerous,
  isMkfsDangerous,
  isChmodWipeDangerous,
];

function matchExtraDetectors(command: string): DestructiveMatch | null {
  let parts: string[];
  try {
    parts = splitCommandParts(command);
  } catch {
    parts = [command];
  }
  if (parts.length === 0) parts = [command];
  for (const sub of parts) {
    const trimmed = sub.trim();
    if (trimmed.length === 0) continue;
    for (const detector of EXTRA_DETECTORS) {
      const match = detector(trimmed);
      if (match) return match;
    }
  }
  return null;
}

export function detectDestructiveCommand(command: string): DestructiveMatch | null {
  const extra = matchExtraDetectors(command);
  if (extra) return extra;
  return matchRegexPatterns(command);
}

export function getDestructiveCommandWarning(command: string): string | null {
  return detectDestructiveCommand(command)?.warning ?? null;
}

export function getDestructiveCommandCategory(command: string): DestructiveCategory | null {
  return detectDestructiveCommand(command)?.category ?? null;
}

const DISABLE_VALUES = new Set(["0", "false", "no", "off"]);

export function isDestructiveWarnEnabled(): boolean {
  const v = (process.env.OTHERSIDE_DESTRUCTIVE_WARN ?? "").trim().toLowerCase();
  if (v.length === 0) return true;
  return !DISABLE_VALUES.has(v);
}
