import type { ToolCall } from "@/kernel/std/types/message.ts";
import { loadNestedMemoryForPath } from "@/kernel/storage/memory/nested.ts";
import type { AgentDeps } from "./turn/types.ts";

export interface NestedMemoryStore {
  loadedPaths: Set<string>;
  byPath: Map<string, string>;
}

export function collectNestedMemoryForTool(
  deps: AgentDeps,
  store: NestedMemoryStore,
  call: ToolCall,
): void {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const candidates: string[] = [];
  for (const key of ["file_path", "path", "filePath", "directory", "cwd"]) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) candidates.push(v);
  }
  if (call.name === "Bash" && typeof input.command === "string") {
    const matches = input.command.match(/(?:^|\s)([./~][\w./-]+)/g);
    if (matches) {
      for (const m of matches) candidates.push(m.trim());
    }
  }
  if (candidates.length === 0) return;
  const cwd = deps.session.cwd;
  for (const candidate of candidates) {
    const nested = loadNestedMemoryForPath(candidate, cwd);
    if (!nested) continue;
    if (store.loadedPaths.has(nested.path)) continue;
    store.loadedPaths.add(nested.path);
    store.byPath.set(nested.path, nested.content);
  }
}
