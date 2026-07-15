import { posix, resolve } from "node:path";
import { isFdRedirectAmpersand } from "@/kernel/permissions/bash-matcher.ts";

const ACCEPT_EDITS_TOOLS = new Set<string>(["Edit", "Write", "NotebookEdit"]);

export function isAcceptEditsTool(toolName: string): boolean {
  return ACCEPT_EDITS_TOOLS.has(toolName);
}

const SENSITIVE_PATH_PREFIXES = ["/etc/", "/root/", "/private/etc/", "/private/var/db/"].map(
  normalizeCaseForComparison,
);

// Always normalize to lowercase, regardless of platform, so mixed-case paths cannot
// bypass these checks on case-insensitive filesystems.
function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase();
}

const SENSITIVE_FILE_BASENAMES = new Set<string>(
  [
    ".env",
    ".env.local",
    ".env.production",
    ".env.staging",
    ".npmrc",
    ".netrc",
    ".yarnrc",
    ".yarnrc.yml",
    "id_rsa",
    "id_ed25519",
    "credentials",
    ".gitconfig",
    ".gitmodules",
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".bash_aliases",
    ".bash_logout",
    ".zshrc",
    ".zprofile",
    ".zshenv",
    ".zlogin",
    ".zlogout",
    ".profile",
    ".envrc",
    ".ripgreprc",
    ".mcp.json",
    ".pnp.cjs",
    ".pnp.loader.mjs",
    ".pnpmfile.cjs",
    "bunfig.toml",
    ".bunfig.toml",
    ".bazelrc",
    ".bazelversion",
    ".bazeliskrc",
    ".pre-commit-config.yaml",
    "lefthook.yml",
    ".lefthook.yml",
    "lefthook.yaml",
    ".lefthook.yaml",
    "gradle-wrapper.properties",
    "maven-wrapper.properties",
    ".devcontainer.json",
    "pyrightconfig.json",
  ].map(normalizeCaseForComparison),
);

const SENSITIVE_DIR_SEGMENTS = new Set<string>(
  [
    ".git",
    ".vscode",
    ".idea",
    ".husky",
    ".cargo",
    ".devcontainer",
    ".yarn",
    ".mvn",
    ".otherside",
  ].map(normalizeCaseForComparison),
);

const SENSITIVE_MULTI_SEGMENT_PATHS = [".config/git"].map(normalizeCaseForComparison);

export function isSensitiveFilePath(path: string, cwd?: string): boolean {
  // Resolve relative paths against the SESSION cwd, not the process cwd — a bash
  // command runs in ctx.cwd, so `rm ../../etc/passwd` under a tracked cwd of `/`
  // must resolve to /etc/passwd here too, or the traversal auto-approves.
  const base = cwd ?? process.cwd();
  // Bash tool input uses Unix path syntax even when the CLI host is Windows.
  // Preserve native resolution for native paths, but do not let node:path.win32
  // reinterpret a leading `/` fixture or Bash path as drive-relative.
  const resolved = (
    path.startsWith("/") || base.startsWith("/")
      ? posix.resolve(base.replaceAll("\\", "/"), path)
      : resolve(base, path)
  ).replaceAll("\\", "/");
  const normalizedPath = normalizeCaseForComparison(resolved);
  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    if (normalizedPath.startsWith(prefix)) return true;
  }
  const pathSegments = normalizedPath.split("/");
  const basename = pathSegments.at(-1) ?? "";
  if (SENSITIVE_FILE_BASENAMES.has(basename)) return true;
  // Check every segment, including the final one, so that a sensitive
  // directory named as the exact/only positional arg (e.g. `rm -rf .git`)
  // is flagged, not just paths nested inside it (e.g. `.git/config`).
  for (const seg of pathSegments) {
    if (SENSITIVE_DIR_SEGMENTS.has(seg)) return true;
  }
  for (const segmentPath of SENSITIVE_MULTI_SEGMENT_PATHS) {
    const segments = segmentPath.split("/");
    for (let i = 0; i + segments.length <= pathSegments.length; i++) {
      if (segments.every((segment, offset) => pathSegments[i + offset] === segment)) return true;
    }
  }
  if (/(^|\/)\.ssh\//.test(normalizedPath)) return true;
  if (/(^|\/)\.aws\/credentials$/.test(normalizedPath)) return true;
  return false;
}

const WRITE_TOOLS_WITH_FILE_PATH = new Set<string>(["Write", "Edit"]);
const NOTEBOOK_WRITE_TOOL = "NotebookEdit";

function extractPathFromInput(input: unknown, key: string): string {
  if (!input || typeof input !== "object" || !(key in input)) return "";
  return String((input as Record<string, unknown>)[key] ?? "");
}

// A symlink inside the workspace can point at a sensitive location (e.g.
// `alias -> .git`), so `isSensitiveFilePath` must run over every symlink-chain
// and best-effort resolved representation of the target, not just the lexical
// input — otherwise accept-edits/Bash-write auto-allow can be bypassed by
// writing through the alias instead of the real path. Callers that already
// compute those representations (permission-resolution.ts) inject them here;
// callers that don't get the lexical-only check as a safe default.
export function isSensitiveWriteApprovable(
  toolName: string,
  input: unknown,
  cwd?: string,
  pathRepresentations: (path: string, cwd?: string) => string[] = (path) => [path],
): boolean {
  if (WRITE_TOOLS_WITH_FILE_PATH.has(toolName)) {
    const filePath = extractPathFromInput(input, "file_path");
    if (
      filePath &&
      pathRepresentations(filePath, cwd).some((path) => isSensitiveFilePath(path, cwd))
    )
      return false;
  }
  if (toolName === NOTEBOOK_WRITE_TOOL) {
    const notebookPath = extractPathFromInput(input, "notebook_path");
    if (
      notebookPath &&
      pathRepresentations(notebookPath, cwd).some((path) => isSensitiveFilePath(path, cwd))
    )
      return false;
  }
  return true;
}

const ACCEPT_EDITS_BASH_PREFIXES = new Set<string>([
  "mkdir",
  "touch",
  "rm",
  "rmdir",
  "mv",
  "cp",
  "sed",
]);

export function splitBashSubcommands(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < cmd.length) {
    const c = cmd[i] as string;
    if (inSingle) {
      if (c === "'") inSingle = false;
      cur += c;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        cur += c + (cmd[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === '"') inDouble = false;
      cur += c;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      cur += c;
      i++;
      continue;
    }
    if (c === "&" && cmd[i + 1] === "&") {
      out.push(cur);
      cur = "";
      i += 2;
      continue;
    }
    if (c === "&" && !isFdRedirectAmpersand(cmd, i)) {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === "|" && cmd[i + 1] === "|") {
      out.push(cur);
      cur = "";
      i += 2;
      continue;
    }
    if (c === ";") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === "|") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function extractArgs(subcmd: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < subcmd.length) {
    const c = subcmd[i] as string;
    if (inSingle) {
      if (c === "'") inSingle = false;
      else cur += c;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        cur += subcmd[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inDouble = false;
      else cur += c;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += c;
    }
    i++;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

function isWorkspaceDescendant(filePath: string, cwd: string): boolean {
  if (filePath === "~" || filePath.startsWith("~/")) return false;
  const normalizedCwd = (cwd.startsWith("/") ? posix.resolve(cwd) : resolve(cwd)).replaceAll(
    "\\",
    "/",
  );
  const normalizedPath = (
    filePath.startsWith("/") || cwd.startsWith("/")
      ? posix.resolve(normalizedCwd, filePath.replaceAll("\\", "/"))
      : resolve(cwd, filePath)
  ).replaceAll("\\", "/");
  return normalizedPath.startsWith(`${normalizedCwd}/`);
}

export function isAcceptEditsBash(command: string, cwd?: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;

  // Reject shell expansions, wildcards, and backslash escapes that could bypass static checks
  let state: "unquoted" | "single-quoted" | "double-quoted" = "unquoted";
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (state === "unquoted") {
      if (c === "'") {
        state = "single-quoted";
      } else if (c === '"') {
        state = "double-quoted";
      } else if (
        c === "$" ||
        c === "*" ||
        c === "?" ||
        c === "[" ||
        c === "]" ||
        c === "\\" ||
        c === "`"
      ) {
        return false;
      }
    } else if (state === "single-quoted") {
      if (c === "'") {
        state = "unquoted";
      }
    } else if (state === "double-quoted") {
      if (c === '"') {
        state = "unquoted";
      } else if (c === "$" || c === "\\" || c === "`") {
        return false;
      }
    }
  }
  if (state !== "unquoted") {
    return false;
  }

  const subs = splitBashSubcommands(trimmed);
  if (subs.length === 0) return false;
  let any = false;
  for (const sub of subs) {
    const t = sub.trim();
    if (t.length === 0) continue;
    const tokens = extractArgs(t);
    const baseCmd = tokens[0];
    if (!baseCmd || !ACCEPT_EDITS_BASH_PREFIXES.has(baseCmd)) return false;
    for (let j = 1; j < tokens.length; j++) {
      const arg = tokens[j];
      if (!arg) continue;
      if (arg.startsWith("-") || arg.startsWith("+")) {
        if (arg.includes("=")) return false;
        continue;
      }
      if (isSensitiveFilePath(arg, cwd)) return false;
      if (cwd && !isWorkspaceDescendant(arg, cwd)) return false;
    }
    any = true;
  }
  return any;
}
