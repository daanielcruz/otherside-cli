import { statSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import { expandImports } from "@/kernel/storage/memory/expand.ts";
import type { MemoryFile } from "@/kernel/storage/memory/types.ts";
import { canonicalize, canonicalizeDir, readMemoryFile } from "@/kernel/storage/memory/walker.ts";

export function loadNestedMemoryForPath(filePath: string, cwd: string): MemoryFile | null {
  const absRaw = isAbsolute(filePath) ? normalize(filePath) : resolve(cwd, filePath);
  const abs = canonicalizeDir(absRaw);
  const targetDir = statSync(abs, { throwIfNoEntry: false })?.isDirectory() ? abs : dirname(abs);
  const cwdResolved = canonicalize(cwd);
  if (!targetDir.startsWith(cwdResolved)) return null;
  if (targetDir === cwdResolved) return null;
  let cur = targetDir;
  while (cur !== cwdResolved && cur !== dirname(cur)) {
    const candidate = resolve(cur, "OTHERSIDE.md");
    const content = readMemoryFile({ path: candidate, root: cwdResolved });
    if (content !== null) {
      return {
        path: candidate,
        content: expandImports(content, {
          basePath: candidate,
          visited: new Set([candidate]),
          depth: 0,
          containmentRoot: cwdResolved,
        }).trim(),
        scope: "nested",
      };
    }
    cur = dirname(cur);
  }
  return null;
}
