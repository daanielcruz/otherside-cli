import type { Size } from "@/terminal-runtime/geometry/coordinates.js";
import {
  type CharPool,
  createScreen,
  type HyperlinkPool,
  type Screen,
  type StylePool,
} from "@/terminal-runtime/paint/cell-grid.js";
import type { Cursor } from "@/terminal-runtime/terminal/cursor-state.js";

export type Frame = {
  readonly screen: Screen;
  readonly viewport: Size;
  readonly cursor: Cursor;
};

export function emptyFrame(
  rows: number,
  columns: number,
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): Frame {
  return {
    screen: createScreen(0, 0, stylePool, charPool, hyperlinkPool),
    viewport: { width: columns, height: rows },
    cursor: { x: 0, y: 0, visible: true },
  };
}

export type ResyncReason = "resize" | "offscreen" | "clear" | "staticFlush";

export type FrameMetrics = {
  durationMs: number;

  phases?: {
    renderer: number;

    diff: number;

    optimize: number;

    write: number;

    patches: number;

    yoga: number;

    commit: number;

    yogaVisited: number;

    yogaMeasured: number;

    yogaCacheHits: number;

    yogaLive: number;
    domLive?: number;
    fiberLive?: number;
  };
  flickers: Array<{
    desiredHeight: number;
    availableHeight: number;
    reason: ResyncReason;
  }>;
};

export type Patch =
  | { type: "stdout"; content: string }
  | { type: "clear"; count: number }
  | {
      type: "clearTerminal";
      reason: ResyncReason;
      viewportRows: number;

      debug?: { triggerY: number; prevLine: string; nextLine: string } | undefined;
    }
  | { type: "cursorHide" }
  | { type: "cursorShow" }
  | { type: "cursorMove"; x: number; y: number }
  | { type: "cursorTo"; col: number }
  | { type: "carriageReturn" }
  | { type: "hyperlink"; uri: string }
  | { type: "styleStr"; str: string };

export type Diff = Patch[];

export function shouldClearScreen(prevFrame: Frame, frame: Frame): ResyncReason | undefined {
  const didResize =
    frame.viewport.height !== prevFrame.viewport.height ||
    frame.viewport.width !== prevFrame.viewport.width;
  if (didResize) {
    return "resize";
  }

  const currentFrameOverflows = frame.screen.height >= frame.viewport.height;
  const previousFrameOverflowed = prevFrame.screen.height >= prevFrame.viewport.height;
  if (currentFrameOverflows || previousFrameOverflowed) {
    return "offscreen";
  }

  return undefined;
}
