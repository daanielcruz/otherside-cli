import type { TranscriptEntry } from "../types";

export const isPendingId = (id: string): boolean => id.startsWith("t_");

export const isUnsettledUserEcho = (
  entry: TranscriptEntry,
  lastEntry: TranscriptEntry | undefined,
): boolean => entry.kind === "user" && entry === lastEntry;
