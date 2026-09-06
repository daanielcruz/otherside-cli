import { readFileSync } from "node:fs";
import { archiveToolOutput } from "@/engine/tool-output-archive/files.ts";

export interface SpilledCompactionSummaryRef {
  kind: "spilled_compaction_summary";
  filepath: string;
  originalSize: number;
}

export type CompactionSummaryRef = string | SpilledCompactionSummaryRef;

export function compactionSummaryRefFromUnknown(value: unknown): CompactionSummaryRef {
  if (typeof value === "string") return value.trim().length > 0 ? value : "";
  if (!value || typeof value !== "object") return "";
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "spilled_compaction_summary") return "";
  if (typeof raw.filepath !== "string" || raw.filepath.length === 0) return "";
  const originalSize = typeof raw.originalSize === "number" ? raw.originalSize : 0;
  return { kind: "spilled_compaction_summary", filepath: raw.filepath, originalSize };
}

export function isTruthyCompactionSummaryRef(ref: CompactionSummaryRef): boolean {
  if (typeof ref === "string") return ref.trim().length > 0;
  return ref.filepath.length > 0;
}

export function readCompactionSummaryText(ref: CompactionSummaryRef): string {
  if (typeof ref === "string") return ref;
  try {
    return readFileSync(ref.filepath, "utf8");
  } catch (error) {
    console.warn(
      `[session] compact summary spill is unavailable: ${ref.filepath}: ${errorMessage(error)}`,
    );
    return "";
  }
}

export async function spillCompactionSummaryForMemory(
  summary: CompactionSummaryRef,
): Promise<CompactionSummaryRef> {
  if (typeof summary !== "string") return summary;
  if (summary.length === 0) return summary;
  const archived = await archiveToolOutput(summary, `compact-summary-${crypto.randomUUID()}`);
  if ("error" in archived) {
    console.warn(`[session] compact summary spill failed: ${archived.error}`);
    return summary;
  }
  return {
    kind: "spilled_compaction_summary",
    filepath: archived.path,
    originalSize: archived.characterCount,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
