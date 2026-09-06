import { isInterruptionMessage } from "@/engine/queue/runtime/interruption-text.ts";
import type { RewindMode } from "@/engine/session/rewind.ts";
import {
  fileRestoreDiffStatsForTurn,
  fileSnapshotStatsForTurn,
} from "@/kernel/storage/file-history.ts";

/** User turn row used to seed the rewind checkpoint list. */
export interface RewindUserTurn {
  id: string;
  ts?: string;
  text: string;
}

export interface RewindTurn {
  kind: "turn";
  id: string;
  preview: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  firstFileBasename?: string;
  timestamp?: string;
}

export interface CurrentTurn {
  kind: "current";
  id: "__current";
}

export type RewindOption = RewindTurn | CurrentTurn;
export type RestoreOption = RewindMode | "nevermind";

export function userTurnsFromTranscript(
  entries: readonly { id: string; kind: string; text: string }[],
): RewindUserTurn[] {
  const out: RewindUserTurn[] = [];
  for (const entry of entries) {
    if (entry.kind !== "user") continue;
    if (isSlashCommandText(entry.text)) continue;
    if (isInterruptionMessage(entry.text)) continue;
    out.push({ id: entry.id, text: entry.text });
  }
  return out;
}

function isSlashCommandText(text: string): boolean {
  return text.trimStart().startsWith("/");
}

export function rewindTurns(userTurns: readonly RewindUserTurn[], sessionId = ""): RewindTurn[] {
  return userTurns.map((turn) => {
    const stats =
      sessionId.length > 0
        ? fileSnapshotStatsForTurn(sessionId, turn.id)
        : { filesChanged: [] as string[] };
    const diffStats =
      sessionId.length > 0
        ? fileRestoreDiffStatsForTurn(sessionId, turn.id)
        : { insertions: 0, deletions: 0 };
    const first = stats.filesChanged[0];
    const row: RewindTurn = {
      kind: "turn",
      id: turn.id,
      preview: normalizePreview(turn.text),
      filesChanged: stats.filesChanged.length,
      insertions: diffStats.insertions,
      deletions: diffStats.deletions,
    };
    if (first) row.firstFileBasename = basename(first);
    if (turn.ts) row.timestamp = turn.ts;
    return row;
  });
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function normalizePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function restoreOptionsFor(
  filesChanged: number,
): Array<{ mode: RestoreOption; label: string }> {
  if (filesChanged > 0) {
    return [
      { mode: "both", label: "Restore code and conversation" },
      { mode: "conversation", label: "Restore conversation" },
      { mode: "code", label: "Restore code" },
      { mode: "nevermind", label: "Never mind" },
    ];
  }
  return [
    { mode: "conversation", label: "Restore conversation" },
    { mode: "nevermind", label: "Never mind" },
  ];
}

export function formatRelativeTimeSince(date: Date, now: Date = new Date()): string {
  const diffMs = date.getTime() - now.getTime();
  const seconds = Math.trunc(diffMs / 1000);
  const abs = Math.abs(seconds);
  const intervals = [
    { unit: "y", s: 31_536_000 },
    { unit: "mo", s: 2_592_000 },
    { unit: "w", s: 604_800 },
    { unit: "d", s: 86_400 },
    { unit: "h", s: 3_600 },
    { unit: "m", s: 60 },
    { unit: "s", s: 1 },
  ] as const;
  for (const { unit, s } of intervals) {
    if (abs >= s) {
      const value = Math.trunc(abs / s);
      return seconds <= 0 ? `${value}${unit} ago` : `in ${value}${unit}`;
    }
  }
  return seconds <= 0 ? "0s ago" : "in 0s";
}

export function clampRewindIndex(index: number, count: number): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), index));
}

export function pageRewindIndex(
  index: number,
  count: number,
  direction: 1 | -1,
  visibleRows: number,
): number {
  return clampRewindIndex(index + direction * visibleRows, count);
}

export function numericConfirmationIndex(input: string, count: number): number | null {
  if (!/^[1-9]$/.test(input)) return null;
  const index = Number(input) - 1;
  return index < count ? index : null;
}
