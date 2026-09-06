import type { TranscriptScreen } from "@/store/app-store/slices/view.ts";
import { wrapAnsi } from "@/terminal-runtime/text/ansi-wrap.js";

export const COMPACT_OUTPUT_LINES = 3;
export const DETAILED_TRANSCRIPT_MESSAGES = 30;
export const EXPAND_OUTPUT_HINT = "(ctrl+o to expand)";

export type TranscriptPresentation = "compact" | "verbose" | "detailed";

export function transcriptPresentationFor(
  screen: TranscriptScreen,
  verbose: boolean,
): TranscriptPresentation {
  if (screen === "detailed") return "detailed";
  return verbose ? "verbose" : "compact";
}

export interface FoldedOutput<T> {
  readonly visible: readonly T[];
  readonly hidden: number;
}

export function foldOutputRows<T>(
  rows: readonly T[],
  options: { readonly expanded: boolean; readonly edge?: "start" | "end" },
): FoldedOutput<T> {
  if (options.expanded || rows.length <= COMPACT_OUTPUT_LINES + 1) {
    return { visible: rows, hidden: 0 };
  }
  const hidden = rows.length - COMPACT_OUTPUT_LINES;
  const visible =
    options.edge === "end"
      ? rows.slice(-COMPACT_OUTPUT_LINES)
      : rows.slice(0, COMPACT_OUTPUT_LINES);
  return { visible, hidden };
}

export function outputFoldHint(hidden: number): string {
  return `… +${hidden} lines ${EXPAND_OUTPUT_HINT}`;
}

export function wrapOutputRows(text: string, width: number): string[] {
  const content = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (content.length === 0) return [];
  const wrapWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const rows: string[] = [];
  for (const logicalLine of content.split("\n")) {
    const prepared = prepareOutputLine(logicalLine);
    if (prepared.length === 0) {
      rows.push("");
      continue;
    }
    rows.push(
      ...wrapAnsi(prepared, wrapWidth, {
        hard: true,
        trim: false,
        wordWrap: false,
      }).split("\n"),
    );
  }
  return rows;
}

export function selectDetailedTranscriptEntries<T>(
  entries: readonly T[],
  showAll: boolean,
): readonly T[] {
  if (showAll || entries.length <= DETAILED_TRANSCRIPT_MESSAGES) return entries;
  return entries.slice(-DETAILED_TRANSCRIPT_MESSAGES);
}

function prepareOutputLine(line: string): string {
  let prepared = "";
  for (const character of line) {
    if (character === "\t") {
      prepared += "    ";
      continue;
    }
    if (character === "\r" || character === "\b" || character === "\v" || character === "\f") {
      continue;
    }
    prepared +=
      character === "\x1b" || character === "\x07" || character.charCodeAt(0) >= 0x20
        ? character
        : " ";
  }
  return prepared;
}
