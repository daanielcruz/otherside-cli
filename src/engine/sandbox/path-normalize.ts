import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

export const DANGEROUS_FILES = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
] as const;

const DANGEROUS_DIRECTORIES = [".git", ".vscode", ".idea"] as const;

export function listProtectedDirectories(): string[] {
  return [
    ...DANGEROUS_DIRECTORIES.filter((d) => d !== ".git"),
    ".otherside/commands",
    ".otherside/agents",
  ];
}

export function foldPathCase(pathStr: string): string {
  return pathStr.toLowerCase();
}

export function containsGlobChars(pathPattern: string): boolean {
  return (
    pathPattern.includes("*") ||
    pathPattern.includes("?") ||
    pathPattern.includes("[") ||
    pathPattern.includes("]")
  );
}

export function removeTrailingGlobSuffix(pathPattern: string): string {
  const stripped = pathPattern.replace(/\/\*\*$/, "");
  return stripped.length > 0 ? stripped : "/";
}

export function isSymlinkOutsideBoundary(originalPath: string, resolvedPath: string): boolean {
  const normalizedOriginal = normalize(originalPath);
  const normalizedResolved = normalize(resolvedPath);
  if (normalizedResolved === normalizedOriginal) return false;
  if (
    normalizedOriginal.startsWith("/tmp/") &&
    normalizedResolved === `/private${normalizedOriginal}`
  ) {
    return false;
  }
  if (
    normalizedOriginal.startsWith("/var/") &&
    normalizedResolved === `/private${normalizedOriginal}`
  ) {
    return false;
  }
  if (normalizedOriginal.startsWith("/private/tmp/") && normalizedResolved === normalizedOriginal) {
    return false;
  }
  if (normalizedOriginal.startsWith("/private/var/") && normalizedResolved === normalizedOriginal) {
    return false;
  }
  if (normalizedResolved === "/") return true;
  const resolvedParts = normalizedResolved.split("/").filter(Boolean);
  if (resolvedParts.length <= 1) return true;
  if (normalizedOriginal.startsWith(`${normalizedResolved}/`)) return true;
  let canonicalOriginal = normalizedOriginal;
  if (normalizedOriginal.startsWith("/tmp/")) {
    canonicalOriginal = `/private${normalizedOriginal}`;
  } else if (normalizedOriginal.startsWith("/var/")) {
    canonicalOriginal = `/private${normalizedOriginal}`;
  }
  if (
    canonicalOriginal !== normalizedOriginal &&
    canonicalOriginal.startsWith(`${normalizedResolved}/`)
  ) {
    return true;
  }
  const resolvedStartsWithOriginal = normalizedResolved.startsWith(`${normalizedOriginal}/`);
  const resolvedStartsWithCanonical =
    canonicalOriginal !== normalizedOriginal &&
    normalizedResolved.startsWith(`${canonicalOriginal}/`);
  const resolvedIsCanonical =
    canonicalOriginal !== normalizedOriginal && normalizedResolved === canonicalOriginal;
  const resolvedIsSame = normalizedResolved === normalizedOriginal;
  if (
    !resolvedIsSame &&
    !resolvedIsCanonical &&
    !resolvedStartsWithOriginal &&
    !resolvedStartsWithCanonical
  ) {
    return true;
  }
  return false;
}

export function normalizePathForSandbox(pathPattern: string): string {
  const cwd = process.cwd();
  let normalizedPath = pathPattern;
  if (pathPattern === "~") {
    normalizedPath = homedir();
  } else if (pathPattern.startsWith("~/")) {
    normalizedPath = homedir() + pathPattern.slice(1);
  } else if (pathPattern.startsWith("./") || pathPattern.startsWith("../")) {
    normalizedPath = resolve(cwd, pathPattern);
  } else if (!isAbsolute(pathPattern)) {
    normalizedPath = resolve(cwd, pathPattern);
  }
  if (containsGlobChars(normalizedPath)) {
    const staticPrefix = normalizedPath.split(/[*?[\]]/)[0] ?? "";
    if (staticPrefix.length > 0 && staticPrefix !== "/") {
      const baseDir = staticPrefix.endsWith("/")
        ? staticPrefix.slice(0, -1)
        : dirname(staticPrefix);
      try {
        const resolvedBaseDir = realpathSync(baseDir);
        if (!isSymlinkOutsideBoundary(baseDir, resolvedBaseDir)) {
          const patternSuffix = normalizedPath.slice(baseDir.length);
          return resolvedBaseDir + patternSuffix;
        }
      } catch {}
    }
    return normalizedPath;
  }
  try {
    const resolvedPath = realpathSync(normalizedPath);
    if (!isSymlinkOutsideBoundary(normalizedPath, resolvedPath)) {
      normalizedPath = resolvedPath;
    }
  } catch {}
  return normalizedPath;
}

export function getDefaultWritePaths(): string[] {
  const home = homedir();
  return [
    "/dev/stdout",
    "/dev/stderr",
    "/dev/null",
    "/dev/tty",
    "/dev/dtracehelper",
    "/dev/autofs_nowait",
    "/tmp/otherside",
    "/private/tmp/otherside",
    join(home, ".npm/_logs"),
    join(home, ".otherside/debug"),
    join(home, ".otherside/shell-snapshots"),
  ];
}

export function globToRegex(globPattern: string): string {
  return `^${globPattern
    .replace(/[.^$+{}()|\\]/g, "\\$&")
    .replace(/\[([^\]]*?)$/g, "\\[$1")
    .replace(/\*\*\//g, "__GLOBSTAR_SLASH__")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__GLOBSTAR_SLASH__/g, "(.*/)?")
    .replace(/__GLOBSTAR__/g, ".*")}$`;
}

export function encodeSandboxedCommand(command: string): string {
  return Buffer.from(command.slice(0, 100)).toString("base64");
}

export function decodeSandboxedCommand(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf8");
}

export function pathExistsSafe(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
