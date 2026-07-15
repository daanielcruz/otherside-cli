import { type AnsiCode, ansiCodesToString, diffAnsiCodes } from "@alcalzone/ansi-tokenize";
import type { Point } from "@/terminal-runtime/geometry/coordinates.js";
import {
  type Cell,
  CellWidth,
  cellAt,
  charInCellAt,
  diffEach,
  type Hyperlink,
  isEmptyCellAt,
  type Screen,
  type StylePool,
  visibleCellAtIndex,
} from "@/terminal-runtime/paint/cell-grid.js";
import type { Diff, Frame, ResyncReason } from "@/terminal-runtime/paint/frame-state.js";
import {
  HYPERLINK_END,
  link as oscLink,
} from "@/terminal-runtime/terminal/operating-system-command.js";
import { emitDiagnosticOutput } from "@/utils/debug.js";

type State = {
  previousOutput: string;
};

type Options = {
  isTTY: boolean;
  stylePool: StylePool;
};

const RETURN_TO_LINE_START = { type: "carriageReturn" } as const;
const ADVANCE_LINE = { type: "stdout", content: "\n" } as const;

export function serializeFrameLines(frame: Frame, stylePool: StylePool): string[] {
  const { screen } = frame;
  const lines: string[] = [];
  let currentStyles: AnsiCode[] = [];
  let currentHyperlink: Hyperlink;
  for (let y = 0; y < screen.height; y++) {
    let line = "";
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAt(screen, x, y);
      if (cell && cell.width !== CellWidth.SpacerTail) {
        if (cell.hyperlink !== currentHyperlink) {
          if (currentHyperlink !== undefined) {
            line += HYPERLINK_END;
          }
          if (cell.hyperlink !== undefined) {
            line += oscLink(cell.hyperlink);
          }
          currentHyperlink = cell.hyperlink;
        }
        const cellStyles = stylePool.get(cell.styleId);
        const styleDiff = diffAnsiCodes(currentStyles, cellStyles);
        if (styleDiff.length > 0) {
          line += ansiCodesToString(styleDiff);
          currentStyles = cellStyles;
        }
        line += cell.char;
      }
    }

    if (currentHyperlink !== undefined) {
      line += HYPERLINK_END;
      currentHyperlink = undefined;
    }

    const resetCodes = diffAnsiCodes(currentStyles, []);
    if (resetCodes.length > 0) {
      line += ansiCodesToString(resetCodes);
      currentStyles = [];
    }
    lines.push(line.trimEnd());
  }

  return lines;
}

export class TerminalRenderBuffer {
  private state: State;

  constructor(private readonly options: Options) {
    this.state = {
      previousOutput: "",
    };
  }

  renderPreviousOutput_DEPRECATED(prevFrame: Frame): Diff {
    if (!this.options.isTTY) {
      return [ADVANCE_LINE];
    }
    return this.getRenderOpsForDone(prevFrame);
  }

  reset(): void {
    this.state.previousOutput = "";
  }

  rebaseAfterStaticFlush(frame: Frame): Diff {
    this.state.previousOutput = "";

    return initiateTerminalReset(frame, "staticFlush", this.options.stylePool, 0);
  }

  private renderFullFrame(frame: Frame): Diff {
    const lines = serializeFrameLines(frame, this.options.stylePool);
    if (lines.length === 0) {
      return [];
    }
    return [{ type: "stdout", content: lines.join("\n") }];
  }

  private getRenderOpsForDone(prev: Frame): Diff {
    this.state.previousOutput = "";

    if (!prev.cursor.visible) {
      return [{ type: "cursorShow" }];
    }
    return [];
  }

  render(prev: Frame, next: Frame, promptRowY?: number): Diff {
    if (!this.options.isTTY) {
      return this.renderFullFrame(next);
    }

    const startTime = performance.now();
    const stylePool = this.options.stylePool;

    const cursorAtBottom = prev.cursor.y >= prev.screen.height;
    const prevHadScrollback = cursorAtBottom && prev.screen.height >= prev.viewport.height;

    const resetScrollbackRows =
      Math.max(0, prev.screen.height - Math.min(prev.viewport.height, next.viewport.height)) +
      (prev.screen.height >= prev.viewport.height ? 1 : 0);

    if (
      next.viewport.height < prev.viewport.height ||
      (next.viewport.height > prev.viewport.height && prevHadScrollback) ||
      (prev.viewport.width !== 0 && next.viewport.width !== prev.viewport.width)
    ) {
      return initiateTerminalReset(next, "resize", stylePool, resetScrollbackRows);
    }

    const isGrowing = next.screen.height > prev.screen.height;

    const isShrinking = next.screen.height < prev.screen.height;

    if (prevHadScrollback && isShrinking) {
      // Two shrinks land here and need opposite handling. A displacing panel
      // above the prompt closing pulls transcript rows back into the viewport
      // from physical scrollback; the incremental path cannot reach above the
      // viewport, so it must take the clamped reset (else a blank band). A
      // footer/menu below the prompt collapsing is a purely trailing shrink;
      // resetting it re-enters scrollback and drags the prompt/log back down.
      // The frame alone cannot tell them apart — both are "tail block shrinks"
      // above scrollback. The prompt caret row does: when no row above it
      // changed (the first differing row is the prompt row itself or lower —
      // clearing the input mutates the prompt row too), the shrink is trailing
      // and stays on the incremental clear-below path, leaving the prompt
      // anchored. When the prompt is not the active surface (a displacing panel
      // owns it) no caret is declared and the reset always runs.
      let firstDiffY = -1;
      diffEach(prev.screen, next.screen, (_x, y) => {
        firstDiffY = y;
        return true;
      });
      const anchoredBelowPrompt = promptRowY !== undefined && firstDiffY >= promptRowY;
      if (!anchoredBelowPrompt) {
        emitDiagnosticOutput(
          `Full reset (shrink w/ scrollback): prevHeight=${prev.screen.height}, nextHeight=${next.screen.height}, viewport=${prev.viewport.height}`,
        );
        return initiateTerminalReset(next, "offscreen", stylePool, resetScrollbackRows);
      }
    }

    if (
      prev.screen.height >= prev.viewport.height &&
      prev.screen.height > 0 &&
      cursorAtBottom &&
      !isGrowing
    ) {
      const viewportY = prev.screen.height - prev.viewport.height;
      const scrollbackRows = viewportY + 1;

      let scrollbackChangeY = -1;
      diffEach(prev.screen, next.screen, (_x, y) => {
        if (y < scrollbackRows) {
          scrollbackChangeY = y;
          return true;
        }
      });
      if (scrollbackChangeY >= 0) {
        const prevLine = extractLineContent(prev.screen, scrollbackChangeY);
        const nextLine = extractLineContent(next.screen, scrollbackChangeY);
        emitDiagnosticOutput(
          `Full reset (scrollback-diff): y=${scrollbackChangeY} prev=${JSON.stringify(prevLine.slice(0, 80))} next=${JSON.stringify(nextLine.slice(0, 80))}`,
        );
        return initiateTerminalReset(next, "offscreen", stylePool, resetScrollbackRows, {
          triggerY: scrollbackChangeY,
          prevLine,
          nextLine,
        });
      }
    }

    const screen = new CursorTrackingBuffer(prev.cursor, next.viewport.width);

    const heightDelta = Math.max(next.screen.height, 1) - Math.max(prev.screen.height, 1);
    const shrinking = heightDelta < 0;
    const growing = heightDelta > 0;

    if (shrinking) {
      const linesToClear = prev.screen.height - next.screen.height;

      if (linesToClear > prev.viewport.height) {
        return initiateTerminalReset(
          next,
          "offscreen",
          this.options.stylePool,
          resetScrollbackRows,
        );
      }

      screen.txn((prev) => [
        [
          { type: "clear", count: linesToClear },
          { type: "cursorMove", x: 0, y: -1 },
        ],
        { dx: -prev.x, dy: -linesToClear },
      ]);
    }

    const scrollCompensationOffset = prevHadScrollback ? 1 : 0;
    const viewportY = growing
      ? Math.max(0, prev.screen.height - prev.viewport.height + scrollCompensationOffset)
      : Math.max(prev.screen.height, next.screen.height) -
        next.viewport.height +
        scrollCompensationOffset;

    let currentStyleId = stylePool.none;
    let currentHyperlink: Hyperlink;

    let needsFullReset = false;
    let resetTriggerY = -1;
    diffEach(prev.screen, next.screen, (x, y, removed, added) => {
      if (growing && y >= prev.screen.height) {
        return;
      }

      if (added && (added.width === CellWidth.SpacerTail || added.width === CellWidth.SpacerHead)) {
        return;
      }

      if (
        removed &&
        (removed.width === CellWidth.SpacerTail || removed.width === CellWidth.SpacerHead) &&
        !added
      ) {
        return;
      }

      if (added && isEmptyCellAt(next.screen, x, y) && !removed) {
        return;
      }

      if (y < viewportY) {
        needsFullReset = true;
        resetTriggerY = y;
        return true;
      }

      positionCursorAt(screen, x, y);

      if (added) {
        const targetHyperlink = added.hyperlink;
        currentHyperlink = applyHyperlinkTransition(screen.diff, currentHyperlink, targetHyperlink);
        const styleStr = stylePool.transition(currentStyleId, added.styleId);
        if (outputStyledCell(screen, added, styleStr)) {
          currentStyleId = added.styleId;
        }
      } else if (removed) {
        const styleIdToReset = currentStyleId;
        const hyperlinkToReset = currentHyperlink;
        currentStyleId = stylePool.none;
        currentHyperlink = undefined;

        screen.txn(() => {
          const patches: Diff = [];
          applyStyleTransition(patches, stylePool, styleIdToReset, stylePool.none);
          applyHyperlinkTransition(patches, hyperlinkToReset, undefined);
          patches.push({ type: "stdout", content: " " });
          return [patches, { dx: 1, dy: 0 }];
        });
      }
    });
    if (needsFullReset) {
      const prevLine = extractLineContent(prev.screen, resetTriggerY);
      const nextLine = extractLineContent(next.screen, resetTriggerY);
      emitDiagnosticOutput(
        `Full reset (above-viewport diff): y=${resetTriggerY} viewportY=${viewportY} prev=${JSON.stringify(prevLine.slice(0, 80))} next=${JSON.stringify(nextLine.slice(0, 80))}`,
      );
      return initiateTerminalReset(next, "offscreen", stylePool, resetScrollbackRows, {
        triggerY: resetTriggerY,
        prevLine,
        nextLine,
      });
    }

    currentStyleId = applyStyleTransition(screen.diff, stylePool, currentStyleId, stylePool.none);
    currentHyperlink = applyHyperlinkTransition(screen.diff, currentHyperlink, undefined);

    if (growing) {
      renderFrameRegion(screen, next, prev.screen.height, next.screen.height, stylePool);
    }

    if (next.cursor.y >= next.screen.height) {
      screen.txn((prev) => {
        const rowsToCreate = next.cursor.y - prev.y;
        if (rowsToCreate > 0) {
          const patches: Diff = new Array<Diff[number]>(1 + rowsToCreate);
          patches[0] = RETURN_TO_LINE_START;
          for (let i = 0; i < rowsToCreate; i++) {
            patches[1 + i] = ADVANCE_LINE;
          }
          return [patches, { dx: -prev.x, dy: rowsToCreate }];
        }

        const dy = next.cursor.y - prev.y;
        if (dy !== 0 || prev.x !== next.cursor.x) {
          const patches: Diff = [RETURN_TO_LINE_START];
          patches.push({ type: "cursorMove", x: next.cursor.x, y: dy });
          return [patches, { dx: next.cursor.x - prev.x, dy }];
        }
        return [[], { dx: 0, dy: 0 }];
      });
    } else {
      positionCursorAt(screen, next.cursor.x, next.cursor.y);
    }

    const elapsed = performance.now() - startTime;
    if (elapsed > 50) {
      const damage = next.screen.damage;
      const damageInfo = damage
        ? `${damage.width}x${damage.height} at (${damage.x},${damage.y})`
        : "none";
      emitDiagnosticOutput(
        `Slow render: ${elapsed.toFixed(1)}ms, screen: ${next.screen.height}x${next.screen.width}, damage: ${damageInfo}, changes: ${screen.diff.length}`,
      );
    }

    return screen.diff;
  }
}

function applyHyperlinkTransition(diff: Diff, current: Hyperlink, target: Hyperlink): Hyperlink {
  if (current !== target) {
    diff.push({ type: "hyperlink", uri: target ?? "" });
    return target;
  }
  return current;
}

function applyStyleTransition(
  diff: Diff,
  stylePool: StylePool,
  currentId: number,
  targetId: number,
): number {
  const str = stylePool.transition(currentId, targetId);
  if (str.length > 0) {
    diff.push({ type: "styleStr", str });
  }
  return targetId;
}

function extractLineContent(screen: Screen, y: number): string {
  let line = "";
  for (let x = 0; x < screen.width; x++) {
    line += charInCellAt(screen, x, y) ?? " ";
  }
  return line.trimEnd();
}

function initiateTerminalReset(
  frame: Frame,
  reason: ResyncReason,
  stylePool: StylePool,
  scrollbackRows: number,
  debug?: { triggerY: number; prevLine: string; nextLine: string },
): Diff {
  const startRow = Math.min(
    scrollbackRows,
    Math.max(0, frame.screen.height - frame.viewport.height + 1),
  );
  const screen = new CursorTrackingBuffer({ x: 0, y: startRow }, frame.viewport.width);
  renderFrameRegion(screen, frame, startRow, frame.screen.height, stylePool);
  return [
    {
      type: "clearTerminal",
      reason,
      viewportRows: frame.viewport.height,
      debug,
    },
    ...screen.diff,
  ];
}

function renderFrameRegion(
  screen: CursorTrackingBuffer,
  frame: Frame,
  startY: number,
  endY: number,
  stylePool: StylePool,
): CursorTrackingBuffer {
  let currentStyleId = stylePool.none;
  let currentHyperlink: Hyperlink;

  let lastRenderedStyleId = -1;

  const { width: screenWidth, cells, charPool, hyperlinkPool } = frame.screen;

  let index = startY * screenWidth;
  for (let y = startY; y < endY; y += 1) {
    if (screen.cursor.y < y) {
      const rowsToAdvance = y - screen.cursor.y;
      screen.txn((prev) => {
        const patches: Diff = new Array<Diff[number]>(1 + rowsToAdvance);
        patches[0] = RETURN_TO_LINE_START;
        for (let i = 0; i < rowsToAdvance; i++) {
          patches[1 + i] = ADVANCE_LINE;
        }
        return [patches, { dx: -prev.x, dy: rowsToAdvance }];
      });
    }

    lastRenderedStyleId = -1;

    for (let x = 0; x < screenWidth; x += 1, index += 1) {
      const cell = visibleCellAtIndex(cells, charPool, hyperlinkPool, index, lastRenderedStyleId);
      if (!cell) {
        continue;
      }

      positionCursorAt(screen, x, y);

      const targetHyperlink = cell.hyperlink;
      currentHyperlink = applyHyperlinkTransition(screen.diff, currentHyperlink, targetHyperlink);

      const styleStr = stylePool.transition(currentStyleId, cell.styleId);
      if (outputStyledCell(screen, cell, styleStr)) {
        currentStyleId = cell.styleId;
        lastRenderedStyleId = cell.styleId;
      }
    }

    currentStyleId = applyStyleTransition(screen.diff, stylePool, currentStyleId, stylePool.none);
    currentHyperlink = applyHyperlinkTransition(screen.diff, currentHyperlink, undefined);

    screen.txn((prev) => [[RETURN_TO_LINE_START, ADVANCE_LINE], { dx: -prev.x, dy: 1 }]);
  }

  applyStyleTransition(screen.diff, stylePool, currentStyleId, stylePool.none);
  applyHyperlinkTransition(screen.diff, currentHyperlink, undefined);

  return screen;
}

type CursorDelta = { dx: number; dy: number };

function outputStyledCell(screen: CursorTrackingBuffer, cell: Cell, styleStr: string): boolean {
  const cellWidth = cell.width === CellWidth.Wide ? 2 : 1;
  const px = screen.cursor.x;
  const vw = screen.viewportWidth;

  if (cellWidth === 2 && px < vw) {
    const threshold = cell.char.length > 2 ? vw : vw + 1;
    if (px + 2 >= threshold) {
      return false;
    }
  }

  const diff = screen.diff;
  if (styleStr.length > 0) {
    diff.push({ type: "styleStr", str: styleStr });
  }

  const needsCompensation = cellWidth === 2 && requiresWidthAdjustment(cell.char);

  if (needsCompensation && px + 1 < vw) {
    diff.push({ type: "cursorTo", col: px + 2 });
    diff.push({ type: "stdout", content: " " });
    diff.push({ type: "cursorTo", col: px + 1 });
  }

  diff.push({ type: "stdout", content: cell.char });

  if (needsCompensation) {
    diff.push({ type: "cursorTo", col: px + cellWidth + 1 });
  }

  if (px >= vw) {
    screen.cursor.x = cellWidth;
    screen.cursor.y++;
  } else {
    screen.cursor.x = px + cellWidth;
  }
  return true;
}

function positionCursorAt(screen: CursorTrackingBuffer, targetX: number, targetY: number) {
  screen.txn((prev) => {
    const dx = targetX - prev.x;
    const dy = targetY - prev.y;
    const inPendingWrap = prev.x >= screen.viewportWidth;

    if (inPendingWrap) {
      return [[RETURN_TO_LINE_START, { type: "cursorMove", x: targetX, y: dy }], { dx, dy }];
    }

    if (dy !== 0) {
      return [[RETURN_TO_LINE_START, { type: "cursorMove", x: targetX, y: dy }], { dx, dy }];
    }

    return [[{ type: "cursorMove", x: dx, y: dy }], { dx, dy }];
  });
}

function requiresWidthAdjustment(char: string): boolean {
  const cp = char.codePointAt(0);
  if (cp === undefined) return false;

  if ((cp >= 0x1fa70 && cp <= 0x1faff) || (cp >= 0x1fb00 && cp <= 0x1fbff)) {
    return true;
  }

  if (char.length >= 2) {
    for (let i = 0; i < char.length; i++) {
      if (char.charCodeAt(i) === 0xfe0f) return true;
    }
  }
  return false;
}

class CursorTrackingBuffer {
  cursor: Point;
  diff: Diff = [];

  constructor(
    origin: Point,
    readonly viewportWidth: number,
  ) {
    this.cursor = { ...origin };
  }

  txn(fn: (prev: Point) => [patches: Diff, next: CursorDelta]): void {
    const [patches, next] = fn(this.cursor);
    for (const patch of patches) {
      this.diff.push(patch);
    }
    this.cursor.x += next.dx;
    this.cursor.y += next.dy;
  }
}
