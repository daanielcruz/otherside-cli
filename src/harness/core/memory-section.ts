import type { MemoryFile, MemoryScope } from "@/kernel/std/types/memory.ts";

export const PREAMBLE =
  "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

export function describeScope(scope: MemoryScope): string {
  if (scope === "user") return " (user's private global instructions for all projects)";
  if (scope === "nested") return " (nested directory instructions, applied via tool path)";
  if (scope === "automem") return " (user's auto-memory, persists across conversations)";
  return " (project instructions, checked into the codebase)";
}

export function renderMemorySection(files: MemoryFile[]): string | null {
  if (files.length === 0) return null;
  const wrapped = files.map(
    (f) => `Contents of ${f.path}${describeScope(f.scope)}:\n\n${f.content}`,
  );
  return `# otherside\n${PREAMBLE}\n\n${wrapped.join("\n\n")}`;
}

export function nestedMemoryFiles(items: { path: string; content: string }[]): MemoryFile[] {
  return items.map((item) => ({ path: item.path, content: item.content, scope: "nested" }));
}
