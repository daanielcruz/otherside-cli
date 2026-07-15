import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { hasFrontmatterFence, parseFrontmatter } from "@/engine/agents/frontmatter.ts";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryHeader {
  filename: string;
  filePath: string;
  mtimeMs: number;
  description: string | null;
  type: MemoryType | undefined;
}

const MAX_MEMORY_FILES = 200;
const FRONTMATTER_MAX_LINES = 30;
const MAX_SCAN_FILE_BYTES = 256 * 1024;

function parseMemoryType(raw: string | undefined): MemoryType | undefined {
  return MEMORY_TYPES.find((t) => t === raw);
}

export async function scanMemoryFiles(
  memoryDir: string,
  signal?: AbortSignal,
): Promise<MemoryHeader[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true });
    const mdFiles = entries.filter((f) => f.endsWith(".md") && basename(f) !== "MEMORY.md");
    const results = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = join(memoryDir, relativePath);
        const st = await stat(filePath);
        if (!st.isFile() || st.size > MAX_SCAN_FILE_BYTES) {
          throw new Error("not a scannable memory file");
        }
        const raw = await readFile(filePath, "utf8");
        const head = raw.split("\n").slice(0, FRONTMATTER_MAX_LINES).join("\n");
        let description: string | null = null;
        let type: MemoryType | undefined;
        if (hasFrontmatterFence(head)) {
          try {
            const parsed = parseFrontmatter(head);
            description = parsed.fields.description ?? null;
            type = parseMemoryType(parsed.fields.type);
          } catch {}
        }
        return { filename: relativePath, filePath, mtimeMs: st.mtimeMs, description, type };
      }),
    );
    if (signal?.aborted) return [];
    return results
      .filter((r): r is PromiseFulfilledResult<MemoryHeader> => r.status === "fulfilled")
      .map((r) => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES);
  } catch {
    return [];
  }
}

export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map((m) => {
      const tag = m.type ? `[${m.type}] ` : "";
      const ts = new Date(m.mtimeMs).toISOString();
      const head = `- ${tag}${m.filename} (${ts})`;
      return m.description ? `${head}: ${m.description}` : head;
    })
    .join("\n");
}
