import type { Styles } from "@/terminal-runtime/paint/style-model.js";
import truncateAnsiString from "@/terminal-runtime/text/ansi-slice.js";
import { wrapAnsi } from "@/terminal-runtime/text/ansi-wrap.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";

const ELLIPSIS = "…";

function sliceFit(text: string, start: number, end: number): string {
  const s = truncateAnsiString(text, start, end);
  return stringWidth(s) > end - start ? truncateAnsiString(text, start, end - 1) : s;
}

function truncate(text: string, columns: number, position: "start" | "middle" | "end"): string {
  if (columns < 1) return "";
  if (columns === 1) return ELLIPSIS;

  const length = stringWidth(text);
  if (length <= columns) return text;

  if (position === "start") {
    return ELLIPSIS + sliceFit(text, length - columns + 1, length);
  }
  if (position === "middle") {
    const half = Math.floor(columns / 2);
    return (
      sliceFit(text, 0, half) + ELLIPSIS + sliceFit(text, length - (columns - half) + 1, length)
    );
  }
  return sliceFit(text, 0, columns - 1) + ELLIPSIS;
}

const LEADING_ANSI_RE = /^(?:\u001b\[[0-9;]*m|\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\))*/;

export function elideWrapBoundarySpace(line: string): { line: string; elided: boolean } {
  const prefixLen = LEADING_ANSI_RE.exec(line)?.[0].length ?? 0;
  if (line[prefixLen] !== " ") return { line, elided: false };
  const rest = line.slice(prefixLen + 1);

  if (stringWidth(rest) === 0) return { line, elided: false };
  return { line: line.slice(0, prefixLen) + rest, elided: true };
}

export default function wrapText(
  text: string,
  maxWidth: number,
  wrapType: Styles["textWrap"],
): string {
  if (wrapType === "wrap" || wrapType === "wrap-stream") {
    return wrapAnsi(text, maxWidth, { trim: false, hard: true });
  }

  if (wrapType === "wrap-trim") {
    return wrapAnsi(text, maxWidth, {
      trim: true,
      hard: true,
    });
  }

  if (wrapType!.startsWith("truncate")) {
    let position: "end" | "middle" | "start" = "end";

    if (wrapType === "truncate-middle") {
      position = "middle";
    }

    if (wrapType === "truncate-start") {
      position = "start";
    }

    return truncate(text, maxWidth, position);
  }

  return text;
}
