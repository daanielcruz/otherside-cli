import type { TranscriptEntry } from "@/ui/transcript/types.ts";

export function elapsedMs(startedAt: number, endedAt: number | undefined): number {
  return endedAt !== undefined && endedAt > startedAt ? endedAt - startedAt : 0;
}

export function estimateTokens(entries: readonly TranscriptEntry[], live: string): number {
  const chars = entries.reduce((sum, entry) => sum + entry.text.length, live.length);
  return Math.max(0, Math.ceil(chars / 4));
}
