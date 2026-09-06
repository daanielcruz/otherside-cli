import type { CaretPosition } from "@/terminal-runtime/string-view/component.js";
import {
  BEGIN_SYNCHRONIZED_OUTPUT,
  CURSOR_HOME,
  cursorDown,
  cursorForward,
  cursorPosition,
  cursorUp,
  END_SYNCHRONIZED_OUTPUT,
  ERASE_LINE,
  ERASE_SCREEN,
  ERASE_SCROLLBACK,
} from "@/terminal-runtime/terminal/control-sequences.js";

export type InlinePaintGeometry = {
  width: number;
  height: number;
  reseed?: boolean;
  /**
   * Where the insertion point sits, in rows of the frame. The real cursor is left
   * there at the end of every paint: it stays hidden, but the terminal draws a pending
   * dead-key composition at it, so leaving it wherever the diff happened to end puts
   * the accent on an unrelated row.
   */
  caret?: CaretPosition | null;
};

export type InlinePaint = {
  bytes: string;
};

export type InlinePainterHooks = {
  onCompareRow?: (row: number) => void;
};

type PaintMemory = {
  lines: readonly string[];
  width: number;
  height: number;
  historyDepth: number;
  penRow: number;
};

type PaintPacket = {
  bytes: string;
  historyDepth: number;
  penRow: number;
  /** True while the bytes still owe their synchronized-output terminator. */
  atomicPending: boolean;
};

export class InlineRowPainter {
  private memory: PaintMemory | undefined;
  private reseedNextPaint = false;

  constructor(private readonly hooks: InlinePainterHooks = {}) {}

  invalidateTerminalMemory(): void {
    this.memory = undefined;
    this.reseedNextPaint = true;
  }

  /** Absolute 1-based screen row the last paint parked the cursor on; null before any paint. */
  parkedScreenRow(): number | null {
    if (this.memory === undefined) return null;
    const screenRows = Math.max(1, this.memory.height);
    const screenRow = Math.min(screenRows - 1, this.memory.penRow - this.memory.historyDepth);
    return Math.max(0, screenRow) + 1;
  }

  emit(nextLines: readonly string[], options: InlinePaintGeometry): InlinePaint {
    return this.emitRows(nextLines, options, 0);
  }

  emitFrame(frameLines: readonly string[], options: InlinePaintGeometry): InlinePaint {
    return this.emitRows(frameLines, options, 0);
  }

  commitScrollback(
    historyRows: readonly string[],
    liveRows: readonly string[],
    options: InlinePaintGeometry,
  ): InlinePaint {
    const result = this.emitRows([...historyRows, ...liveRows], options, historyRows.length);
    this.rebaseToLiveRows(liveRows, options, historyRows.length);
    return result;
  }

  /**
   * Re-lay-out the whole document. By default this is an ordinary paint: the rows are
   * diffed against what is on screen, so a document whose tail grew costs its tail.
   * `regenerate` asks for the destructive reset instead, which erases the scrollback
   * the reader is holding — authorized only when the screen is being taken over by a
   * different document, or when a resize has already invalidated what the terminal shows.
   */
  paintScrollback(
    historyRows: readonly string[],
    liveRows: readonly string[],
    options: InlinePaintGeometry,
    establishSurface = false,
  ): InlinePaint {
    const terminalHasRows = this.memory !== undefined;
    const result = this.emitRows(
      [...historyRows, ...liveRows],
      { ...options, reseed: establishSurface && terminalHasRows },
      historyRows.length,
    );
    this.rebaseToLiveRows(liveRows, options, historyRows.length);
    return result;
  }

  /** `liveRowOffset` places the caller's frame-relative caret among `nextLines`. */
  private emitRows(
    nextLines: readonly string[],
    options: InlinePaintGeometry,
    liveRowOffset: number,
  ): InlinePaint {
    const width = Math.max(1, options.width);
    const height = Math.max(0, options.height);
    const previous = this.memory;
    const rowsToRemember = nextLines.slice();
    const reseed = options.reseed === true || this.reseedNextPaint;
    this.reseedNextPaint = false;

    const caret = offsetCaret(options.caret, liveRowOffset);
    const completePaint = (packet: PaintPacket): InlinePaint => {
      const withCaret = placeCaret(packet, caret, height);
      this.recordPaint(rowsToRemember, width, height, withCaret.historyDepth, withCaret.penRow);
      return { bytes: withCaret.bytes + (withCaret.atomicPending ? END_SYNCHRONIZED_OUTPUT : "") };
    };

    if (previous === undefined && !reseed) {
      return completePaint({
        bytes: serializeRows(nextLines),
        historyDepth: hiddenRowCount(nextLines.length, height),
        penRow: Math.max(0, nextLines.length - 1),
        atomicPending: false,
      });
    }

    if (
      reseed ||
      previous === undefined ||
      previous.width !== width ||
      previous.height !== height
    ) {
      return completePaint(reseedSurface(nextLines, height, liveRowOffset));
    }

    // Identical rows leave the cursor where the last paint parked it, which is already
    // the caret: nothing on screen moved, so re-parking would emit bytes for no reason.
    if (rowsUnchanged(previous.lines, nextLines, this.hooks.onCompareRow)) {
      this.recordPaint(rowsToRemember, width, height, previous.historyDepth, previous.penRow);
      return { bytes: "" };
    }

    if (extendsRows(previous.lines, nextLines, this.hooks.onCompareRow)) {
      return completePaint(
        appendRows({
          appendedLines: nextLines.slice(previous.lines.length),
          priorRowCount: previous.lines.length,
          penRow: previous.penRow,
          historyDepth: previous.historyDepth,
          height,
        }),
      );
    }

    const changedSpan = changedSpanBounds(previous.lines, nextLines, this.hooks.onCompareRow);
    if (changedSpan.start === -1) {
      this.recordPaint(rowsToRemember, width, height, previous.historyDepth, previous.penRow);
      return { bytes: "" };
    }

    const historyPolicy = chooseHistoryEditPolicy(
      previous.historyDepth,
      nextLines.length,
      height,
      changedSpan,
    );
    if (historyPolicy === "recover-visible") {
      return completePaint(
        recoverReachableRows({
          nextLines,
          priorRowCount: previous.lines.length,
          penRow: previous.penRow,
          historyDepth: previous.historyDepth,
          height,
        }),
      );
    }
    if (historyPolicy === "leave-in-history") {
      this.recordPaint(rowsToRemember, width, height, previous.historyDepth, previous.penRow);
      return { bytes: "" };
    }

    return completePaint(
      rewriteDamage({
        previousLines: previous.lines,
        nextLines,
        penRow: previous.penRow,
        // The repaint starts at the first row the cursor can still reach.
        changedSpanStart: Math.max(changedSpan.start, previous.historyDepth),
        changedSpanEnd: changedSpan.end,
        historyDepth: previous.historyDepth,
        height,
      }),
    );
  }

  // Rebases the tracked positions onto the frame that now starts the document: the rows
  // before it are committed and stop being addressable. Both positions shift by the same
  // amount, which is what keeps `row - historyDepth` equal to the real screen row; clamping
  // either one at zero would break that relation and every later move would land wrong.
  private rebaseToLiveRows(
    liveRows: readonly string[],
    options: InlinePaintGeometry,
    archivedRowCount: number,
  ): void {
    const painted = this.memory;
    const width = Math.max(1, options.width);
    const height = Math.max(0, options.height);
    this.recordPaint(
      liveRows.slice(),
      width,
      height,
      (painted?.historyDepth ?? 0) - archivedRowCount,
      (painted?.penRow ?? archivedRowCount) - archivedRowCount,
    );
  }

  private recordPaint(
    lines: readonly string[],
    width: number,
    height: number,
    historyDepth: number,
    penRow: number,
  ): void {
    this.memory = { lines, width, height, historyDepth, penRow };
  }
}

/** The caret's row among the emitted lines, or null when nothing owns one. */
function offsetCaret(
  caret: CaretPosition | null | undefined,
  liveRowOffset: number,
): CaretPosition | null {
  if (caret === null || caret === undefined) return null;
  return { row: liveRowOffset + caret.row, column: Math.max(0, caret.column) };
}

/**
 * Leaves the real cursor on the caret cell. The move is relative like every other move
 * here, and the tracked row follows it: a park the model does not record would throw
 * every later move off by exactly the park distance.
 */
function placeCaret(
  encoded: PaintPacket,
  caret: CaretPosition | null,
  height: number,
): PaintPacket {
  if (caret === null) return encoded;
  const movement = movePen(
    encoded.penRow - encoded.historyDepth,
    caret.row - encoded.historyDepth,
    height,
  );
  return {
    bytes: encoded.bytes + movement.bytes + "\r" + cursorForward(caret.column),
    historyDepth: encoded.historyDepth + movement.historyAdded,
    penRow: caret.row,
    atomicPending: encoded.atomicPending,
  };
}

function reseedSurface(
  lines: readonly string[],
  height: number,
  liveRowOffset: number,
): PaintPacket {
  const history = lines.slice(0, liveRowOffset);
  const live = lines.slice(liveRowOffset);
  const bottomAnchors = height > 0 && live.length > 0 && lines.length <= height;
  const liveStartRow = Math.max(history.length, Math.max(0, height - live.length));
  const surface = bottomAnchors
    ? serializeRows(history) +
      (live.length > 0 ? cursorPosition(liveStartRow + 1, 1) + serializeRows(live) : "")
    : serializeRows(lines);
  const bytes = BEGIN_SYNCHRONIZED_OUTPUT + ERASE_SCREEN + CURSOR_HOME + ERASE_SCROLLBACK + surface;
  return {
    bytes,
    historyDepth: bottomAnchors ? lines.length - height : hiddenRowCount(lines.length, height),
    penRow: Math.max(0, lines.length - 1),
    atomicPending: true,
  };
}

type HistoryEditPolicy = "rewrite-visible" | "recover-visible" | "leave-in-history";

function chooseHistoryEditPolicy(
  historyDepth: number,
  incomingRowCount: number,
  height: number,
  changedSpan: { start: number; end: number },
): HistoryEditPolicy {
  if (changedSpan.start >= historyDepth) return "rewrite-visible";
  if (historyDepth > hiddenRowCount(incomingRowCount, height)) return "recover-visible";
  return changedSpan.end < historyDepth ? "leave-in-history" : "rewrite-visible";
}

/**
 * Repaints the document onto the rows the terminal can still reach, for the case where
 * a frame that had outgrown the screen collapses back. Its head has scrolled into
 * history and stopped being addressable, and an inline surface cannot pull it down
 * again. A destructive reset would answer that by wiping the scrollback the user is
 * reading and throwing their view to the top of it, so instead the document is
 * re-anchored on the first visible row and the rows it no longer fills are cleared
 * where they stand.
 */
function recoverReachableRows(input: {
  nextLines: readonly string[];
  priorRowCount: number;
  penRow: number;
  historyDepth: number;
  height: number;
}): PaintPacket {
  const screenRows = Math.max(1, input.height);
  const cursorScreenRow = Math.max(0, Math.min(screenRows - 1, input.penRow - input.historyDepth));
  let bytes = BEGIN_SYNCHRONIZED_OUTPUT + cursorUp(cursorScreenRow) + "\r";

  // Rows the collapsing document still holds below its new tail are vacated in place.
  const reachableOldRows = Math.min(
    screenRows,
    Math.max(0, input.priorRowCount - input.historyDepth),
  );
  const paintedRows = input.nextLines.length;
  const touchedRows = Math.max(paintedRows, reachableOldRows);

  let historyDepth = 0;
  for (let row = 0; row < touchedRows; row++) {
    if (row > 0) {
      bytes += "\r\n";
      if (row < paintedRows) historyDepth = extendHistoryDepth(historyDepth, row, input.height);
    }
    bytes += ERASE_LINE + (row < paintedRows ? (input.nextLines[row] ?? "") : "");
  }

  const penDestination = Math.max(0, paintedRows - 1);
  const overshootRows = Math.max(0, touchedRows - 1 - penDestination);
  if (overshootRows > 0) bytes += cursorUp(overshootRows);

  return { bytes, historyDepth, penRow: penDestination, atomicPending: true };
}

function appendRows(input: {
  appendedLines: readonly string[];
  priorRowCount: number;
  penRow: number;
  historyDepth: number;
  height: number;
}): PaintPacket {
  let historyDepth = input.historyDepth;
  let bytes = "";

  if (input.priorRowCount > 0) {
    const previousLastRow = input.priorRowCount - 1;
    const movement = movePen(
      input.penRow - historyDepth,
      previousLastRow - historyDepth,
      input.height,
    );
    bytes += movement.bytes + "\r\n";
    historyDepth += movement.historyAdded;
    historyDepth = extendHistoryDepth(historyDepth, previousLastRow + 1, input.height);
  }

  for (let index = 0; index < input.appendedLines.length; index++) {
    if (index > 0) {
      bytes += "\r\n";
      historyDepth = extendHistoryDepth(historyDepth, input.priorRowCount + index, input.height);
    }
    bytes += ERASE_LINE + (input.appendedLines[index] ?? "");
  }

  const penDestination = input.priorRowCount + input.appendedLines.length - 1;
  return {
    bytes,
    historyDepth: extendHistoryDepth(historyDepth, penDestination, input.height),
    penRow: Math.max(0, penDestination),
    atomicPending: false,
  };
}

function rewriteDamage(input: {
  previousLines: readonly string[];
  nextLines: readonly string[];
  penRow: number;
  changedSpanStart: number;
  changedSpanEnd: number;
  historyDepth: number;
  height: number;
}): PaintPacket {
  const priorRowCount = input.previousLines.length;
  let historyDepth = input.historyDepth;
  const movementTargetRow =
    input.changedSpanStart >= input.nextLines.length
      ? Math.max(0, input.nextLines.length - 1)
      : input.changedSpanStart;
  const movement = movePen(
    input.penRow - historyDepth,
    movementTargetRow - historyDepth,
    input.height,
  );
  let bytes = BEGIN_SYNCHRONIZED_OUTPUT + movement.bytes + "\r";
  historyDepth += movement.historyAdded;

  const visibleSpanEnd = Math.min(input.changedSpanEnd, input.nextLines.length - 1);
  let penDestination = input.changedSpanStart;
  for (let row = input.changedSpanStart; row <= visibleSpanEnd; row++) {
    if (row > input.changedSpanStart) {
      bytes += "\r\n";
      historyDepth = extendHistoryDepth(historyDepth, row, input.height);
    }
    penDestination = row;
    // The cursor has to travel across the whole span, but a row inside it whose text
    // did not move is left as the terminal already has it. Two rows ticking on
    // unrelated clocks at opposite ends of the footer would otherwise drag every row
    // between them through an erase-and-rewrite on every frame. A row past the painted
    // document is not on screen yet, so it is written even when its text matches.
    const alreadyOnScreen = row < priorRowCount;
    if (alreadyOnScreen && input.previousLines[row] === input.nextLines[row]) continue;
    bytes += ERASE_LINE + (input.nextLines[row] ?? "");
  }

  if (priorRowCount > input.nextLines.length) {
    if (visibleSpanEnd < input.nextLines.length - 1) {
      const moveDown = input.nextLines.length - 1 - visibleSpanEnd;
      bytes += cursorDown(moveDown);
      penDestination = input.nextLines.length - 1;
    }

    const rowsToErase = priorRowCount - input.nextLines.length;
    if (input.changedSpanStart >= input.nextLines.length) {
      const eraseStep = input.nextLines.length === 0 ? 0 : 1;
      if (eraseStep > 0) bytes += cursorDown(eraseStep);
      for (let index = 0; index < rowsToErase; index++) {
        if (index > 0) bytes += cursorDown();
        bytes += "\r" + ERASE_LINE;
      }
      const returnDistance = Math.max(0, rowsToErase - 1 + eraseStep);
      if (returnDistance > 0) bytes += cursorUp(returnDistance);
    } else {
      for (let index = 0; index < rowsToErase; index++) bytes += "\r\n" + ERASE_LINE;
      bytes += cursorUp(rowsToErase);
    }
    penDestination = Math.max(0, input.nextLines.length - 1);
  }

  return {
    bytes,
    historyDepth: extendHistoryDepth(historyDepth, penDestination, input.height),
    penRow: Math.max(0, penDestination),
    atomicPending: true,
  };
}

function movePen(
  screenOrigin: number,
  screenTarget: number,
  height: number,
): { bytes: string; historyAdded: number } {
  const lastScreenRow = Math.max(0, height - 1);
  const reachableOrigin = Math.max(0, Math.min(lastScreenRow, screenOrigin));
  if (screenTarget > lastScreenRow) {
    const toEdge = lastScreenRow - reachableOrigin;
    const historyAdded = screenTarget - lastScreenRow;
    return {
      bytes: cursorDown(toEdge) + "\r\n".repeat(historyAdded),
      historyAdded,
    };
  }

  const verticalDelta = screenTarget - reachableOrigin;
  return {
    bytes: verticalDelta > 0 ? cursorDown(verticalDelta) : cursorUp(-verticalDelta),
    historyAdded: 0,
  };
}

function changedSpanBounds(
  previousLines: readonly string[],
  nextLines: readonly string[],
  onCompareRow?: (row: number) => void,
): { start: number; end: number } {
  const rowCount = Math.max(previousLines.length, nextLines.length);
  let start = -1;
  let end = -1;
  for (let row = 0; row < rowCount; row++) {
    onCompareRow?.(row);
    // A row past the painted document does not exist on screen yet, so it must
    // be written even when its text matches the blank we would read for it —
    // skipping it would leave the model believing in rows the terminal never
    // created, and every later position would resolve one row too high.
    const beyondPaintedDocument = row >= previousLines.length;
    if (!beyondPaintedDocument && previousLines[row] === nextLines[row]) continue;
    if (start === -1) start = row;
    end = row;
  }
  return { start, end };
}

function extendsRows(
  previousLines: readonly string[],
  nextLines: readonly string[],
  onCompareRow?: (row: number) => void,
): boolean {
  if (nextLines.length <= previousLines.length) return false;
  for (let row = 0; row < previousLines.length; row++) {
    onCompareRow?.(row);
    if (previousLines[row] !== nextLines[row]) return false;
  }
  return true;
}

function rowsUnchanged(
  previousLines: readonly string[],
  nextLines: readonly string[],
  onCompareRow?: (row: number) => void,
): boolean {
  if (previousLines.length !== nextLines.length) return false;
  for (let row = 0; row < previousLines.length; row++) {
    onCompareRow?.(row);
    if (previousLines[row] !== nextLines[row]) return false;
  }
  return true;
}

function serializeRows(lines: readonly string[]): string {
  return lines.join("\r\n");
}

function hiddenRowCount(lineCount: number, height: number): number {
  return Math.max(0, lineCount - height);
}

function extendHistoryDepth(historyDepth: number, documentRow: number, height: number): number {
  if (height <= 0) return historyDepth;
  return Math.max(historyDepth, documentRow - height + 1);
}
