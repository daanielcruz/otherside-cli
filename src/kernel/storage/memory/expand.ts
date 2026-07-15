import { homedir } from "node:os";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import { isContainedWithin, readFileSafe, readMemoryFile } from "@/kernel/storage/memory/walker.ts";

export const MAX_INCLUDE_DEPTH = 5;
export const INCLUDE_REGEX = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;

export interface ExpandOptions {
  basePath: string;
  visited: Set<string>;
  depth: number;
  containmentRoot?: string;
}

function resolveImport(rawPath: string, baseDir: string): string {
  const stripped = rawPath.replace(/\\ /g, " ").split("#")[0]?.trim() ?? "";
  if (stripped.length === 0) return "";
  if (stripped.startsWith("~/")) return resolve(homedir(), stripped.slice(2));
  if (isAbsolute(stripped)) return normalize(stripped);
  return resolve(baseDir, stripped);
}

export function expandImports(source: string, options: ExpandOptions): string {
  const { basePath, visited, depth, containmentRoot } = options;
  if (depth >= MAX_INCLUDE_DEPTH) return source;
  return source.replace(INCLUDE_REGEX, (match, rawPath: string) => {
    const importPath = resolveImport(rawPath, dirname(basePath));
    if (importPath.length === 0) return match;
    const canonical = normalize(importPath);
    if (visited.has(canonical)) return match;
    if (containmentRoot !== undefined && !isContainedWithin(canonical, containmentRoot)) {
      return match;
    }
    const content =
      containmentRoot !== undefined
        ? readMemoryFile({ path: canonical, root: containmentRoot })
        : readFileSafe(canonical);
    if (content === null) return match;
    visited.add(canonical);
    const expanded = expandImports(content, {
      basePath: canonical,
      visited,
      depth: depth + 1,
      ...(containmentRoot !== undefined ? { containmentRoot } : {}),
    });
    const lead = match.startsWith("@") ? "" : match.charAt(0);
    return `${lead}${expanded.trim()}`;
  });
}
