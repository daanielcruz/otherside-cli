import truncateAnsiString from "@/terminal-runtime/text/ansi-slice.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";

/**
 * Clip a rendered line to `max` terminal cells, ANSI-aware, marking the cut
 * with an ellipsis. Every emitted row must fit the frame width: an overlong
 * row breaks physically in the terminal, desynchronizing the writer's row
 * accounting and ghosting neighbouring rows.
 */
export function cellClip(line: string, max: number): string {
  const width = Math.max(0, max);
  if (stringWidth(line) <= width) return line;
  return `${truncateAnsiString(line, 0, Math.max(0, width - 1))}…`;
}
