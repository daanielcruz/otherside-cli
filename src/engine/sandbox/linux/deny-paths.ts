import { readdirSync, statSync } from "node:fs";
import { join, parse as parsePath, resolve, sep } from "node:path";
import {
  DANGEROUS_FILES,
  getDangerousDirectories,
  normalizeCaseForComparison,
} from "@/engine/sandbox/path-normalize.ts";

const DEFAULT_MAX_DEPTH = 3;
const SKIP_DIR_NAMES = new Set(["node_modules", ".cache", "dist", "build", "out", "target"]);

export interface DenyPathsOptions {
  cwd?: string;
  maxDepth?: number;
  allowGitConfig?: boolean;
}

export function linuxGetMandatoryDenyPaths(options: DenyPathsOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const allowGitConfig = options.allowGitConfig === true;
  const dangerousDirs = getDangerousDirectories();
  const denyPaths: string[] = [];
  for (const f of DANGEROUS_FILES) denyPaths.push(resolve(cwd, f));
  for (const d of dangerousDirs) denyPaths.push(resolve(cwd, d));
  const dotGitPath = resolve(cwd, ".git");
  if (statIfDir(dotGitPath)) {
    denyPaths.push(resolve(cwd, ".git/hooks"));
    if (!allowGitConfig) denyPaths.push(resolve(cwd, ".git/config"));
  }
  collectNested({ cwd, denyPaths, maxDepth, allowGitConfig, dangerousDirs });
  return Array.from(new Set(denyPaths));
}

function statIfDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

interface CollectArgs {
  cwd: string;
  denyPaths: string[];
  maxDepth: number;
  allowGitConfig: boolean;
  dangerousDirs: string[];
}

function collectNested(args: CollectArgs): void {
  const dangerousFileSet = new Set(DANGEROUS_FILES.map(normalizeCaseForComparison));
  const dangerousDirSet = new Set(args.dangerousDirs.map(normalizeCaseForComparison));
  walk(args.cwd, 0, args, dangerousFileSet, dangerousDirSet);
}

function walk(
  dir: string,
  depth: number,
  args: CollectArgs,
  dangerousFileSet: Set<string>,
  dangerousDirSet: Set<string>,
): void {
  if (depth > args.maxDepth) return;
  let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
  } catch {
    return;
  }
  for (const entry of entries) {
    const normalizedName = normalizeCaseForComparison(entry.name);
    const fullPath = join(dir, entry.name);
    if (entry.isFile && dangerousFileSet.has(normalizedName)) {
      args.denyPaths.push(fullPath);
      continue;
    }
    if (entry.isDirectory) {
      if (dangerousDirSet.has(normalizedName)) {
        args.denyPaths.push(fullPath);
        continue;
      }
      if (normalizedName === ".git" && depth > 0) {
        args.denyPaths.push(join(fullPath, "hooks"));
        if (!args.allowGitConfig) args.denyPaths.push(join(fullPath, "config"));
        continue;
      }
      if (SKIP_DIR_NAMES.has(normalizedName)) continue;
      if (normalizedName.startsWith(".") && depth >= args.maxDepth) continue;
      walk(fullPath, depth + 1, args, dangerousFileSet, dangerousDirSet);
    }
  }
}

function walkPathSegments(targetPath: string): { root: string; segments: string[] } {
  const { root } = parsePath(targetPath);
  const tail = targetPath.slice(root.length);
  const segments = tail.split(sep).filter(Boolean);
  return { root, segments };
}

export function findSymlinkInPath(targetPath: string, allowedWritePaths: string[]): string | null {
  const { root, segments } = walkPathSegments(targetPath);
  let current = root;
  for (const part of segments) {
    current = current === root ? root + part : join(current, part);
    try {
      const { lstatSync } = require("node:fs") as typeof import("node:fs");
      const s = lstatSync(current);
      if (s.isSymbolicLink()) {
        const within = allowedWritePaths.some((p) => current.startsWith(p + sep) || current === p);
        if (within) return current;
      }
    } catch {
      break;
    }
  }
  return null;
}

export function hasFileAncestor(targetPath: string): boolean {
  const { root, segments } = walkPathSegments(targetPath);
  let current = root;
  for (const part of segments) {
    current = current === root ? root + part : join(current, part);
    try {
      const s = statSync(current);
      if (s.isFile() || s.isSymbolicLink()) return true;
    } catch {
      break;
    }
  }
  return false;
}

export function findFirstNonExistentComponent(targetPath: string): string {
  const { root, segments } = walkPathSegments(targetPath);
  let current = root;
  for (const part of segments) {
    current = current === root ? root + part : join(current, part);
    try {
      statSync(current);
    } catch {
      return current;
    }
  }
  return targetPath;
}
