import { resolve } from "node:path";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import {
  autoMemEntrypoint,
  truncateEntrypointContent,
} from "@/kernel/storage/memory/entrypoint.ts";
import { expandImports } from "@/kernel/storage/memory/expand.ts";
import { isAutoMemoryEnabled } from "@/kernel/storage/memory/session-toggle.ts";
import type { MemoryFile } from "@/kernel/storage/memory/types.ts";
import {
  canonicalize,
  readFileSafe,
  readMemoryFile,
  walkAncestors,
} from "@/kernel/storage/memory/walker.ts";

const MEMORY_FILE_NAMES = ["OTHERSIDE.md", "CLAUDE.md"] as const;

function firstUserMemory(userRoot: string): { path: string; content: string } | null {
  for (const name of MEMORY_FILE_NAMES) {
    const path = resolve(userRoot, name);
    const content = readFileSafe(path);
    if (content !== null) return { path, content };
  }
  return null;
}

function firstProjectMemory(
  dir: string,
  dirRoot: string,
): { path: string; content: string } | null {
  for (const name of MEMORY_FILE_NAMES) {
    const path = resolve(dir, name);
    const content = readMemoryFile({ path, root: dirRoot });
    if (content !== null) return { path, content };
  }
  return null;
}

function autoMemFile(cwd: string, visited: Set<string>): MemoryFile | null {
  if (!isAutoMemoryEnabled()) return null;
  const entrypoint = autoMemEntrypoint(cwd);
  if (visited.has(entrypoint)) return null;
  const raw = readFileSafe(entrypoint);
  if (raw === null || raw.trim().length === 0) return null;
  visited.add(entrypoint);
  return { path: entrypoint, content: truncateEntrypointContent(raw), scope: "automem" };
}

export function collectMemoryFiles(cwd: string): MemoryFile[] {
  const out: MemoryFile[] = [];
  const visited = new Set<string>();

  const userRoot = canonicalize(configRoot());
  const user = firstUserMemory(userRoot);
  if (user !== null && !visited.has(user.path)) {
    visited.add(user.path);
    out.push({
      path: user.path,
      content: expandImports(user.content, {
        basePath: user.path,
        visited: new Set([user.path]),
        depth: 0,
        containmentRoot: userRoot,
      }).trim(),
      scope: "user",
    });
  }

  for (const dir of walkAncestors(cwd)) {
    const dirRoot = canonicalize(dir);
    const project = firstProjectMemory(dir, dirRoot);
    if (project === null) continue;
    if (visited.has(project.path)) continue;
    visited.add(project.path);
    out.push({
      path: project.path,
      content: expandImports(project.content, {
        basePath: project.path,
        visited: new Set([project.path]),
        depth: 0,
        containmentRoot: dirRoot,
      }).trim(),
      scope: "project",
    });
  }

  const auto = autoMemFile(cwd, visited);
  if (auto !== null) out.push(auto);

  return out;
}
