import { readFile, stat } from "node:fs/promises";
import { memoryAge, memoryFreshnessText } from "@/kernel/std/perf/memory-age.ts";
import type { RelevantMemory } from "./select.ts";

export const MAX_MEMORY_LINES = 200;
export const MAX_MEMORY_BYTES = 4096;
const FILE_READ_TOOL_NAME = "Read";

export interface RecalledMemory {
  path: string;
  content: string;
  mtimeMs: number;
  header: string;
}

export function memoryHeader(path: string, mtimeMs: number): string {
  const staleness = memoryFreshnessText(mtimeMs);
  return staleness
    ? `${staleness}\n\nMemory: ${path}:`
    : `Memory (saved ${memoryAge(mtimeMs)}): ${path}:`;
}

function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
}

export function clampMemoryContent(
  raw: string,
  filePath: string,
): { content: string; truncated: boolean } {
  const lines = raw.split("\n");
  const truncatedByLines = lines.length > MAX_MEMORY_LINES;
  let content = truncatedByLines ? lines.slice(0, MAX_MEMORY_LINES).join("\n") : raw;
  const truncatedByBytes = Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES;
  if (truncatedByBytes) {
    content = truncateToBytes(content, MAX_MEMORY_BYTES);
  }
  const truncated = truncatedByLines || truncatedByBytes;
  if (truncated) {
    content += `\n\n> This memory file was truncated (${truncatedByBytes ? `${MAX_MEMORY_BYTES} byte limit` : `first ${MAX_MEMORY_LINES} lines`}). Use the ${FILE_READ_TOOL_NAME} tool to view the complete file at: ${filePath}`;
  }
  return { content, truncated };
}

export async function readMemoriesForSurfacing(
  selected: readonly RelevantMemory[],
  signal?: AbortSignal,
): Promise<RecalledMemory[]> {
  const results = await Promise.all(
    selected.map(async ({ path: filePath, mtimeMs }): Promise<RecalledMemory | null> => {
      try {
        if (signal?.aborted) return null;
        const st = await stat(filePath);
        if (!st.isFile()) return null;
        const raw = await readFile(filePath, "utf8");
        const { content } = clampMemoryContent(raw, filePath);
        return {
          path: filePath,
          content,
          mtimeMs,
          header: memoryHeader(filePath, mtimeMs),
        };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is RecalledMemory => r !== null);
}

export function formatRecallReminder(memory: RecalledMemory): string {
  return `<system-reminder>\n${memory.header}\n\n${memory.content}\n</system-reminder>`;
}
