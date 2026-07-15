import { type ReactNode, useRef } from "react";
import { Box, useTerminalDimensions, useVisibleRegion } from "@/ink";

/**
 * Freezes children once they scroll above the terminal viewport (into
 * scrollback). Any content change above the fold forces the renderer into a
 * full terminal reset (it cannot partially repaint rows that have scrolled out);
 * for content that updates on a timer — spinners, elapsed counters — or a
 * shifting header count, that is one reset per tick. While the subtree is
 * off-screen this returns the SAME element reference cached during the last
 * visible render, so React's reconciler bails and the subtree produces zero
 * diff. Content still updates normally while visible. Otherside has no virtual list, so terminal scrollback is the only path and there is nothing to exempt.
 */
export function OffscreenFreeze({ children }: { children: ReactNode }): React.JSX.Element {
  const [setElement, visibility] = useVisibleRegion();
  const { columns } = useTerminalDimensions();
  const cached = useRef(children);
  const cachedColumns = useRef(columns);
  // Top-clipped counts as offscreen: a block whose top rows crossed the fold
  // while its bottom is still visible would otherwise keep updating those
  // scrollback rows (agent progress sliding window, blinking headers) — one
  // full terminal reset per update.
  //
  // A width change bypasses the freeze: cached children carry the old
  // terminal width in their props, and painting a stale-width row after a
  // resize wraps it across multiple physical lines — every row below lands
  // off by the wrap count and the footer walks off the screen.
  if ((visibility.isVisible && !visibility.topClipped) || cachedColumns.current !== columns) {
    cached.current = children;
    cachedColumns.current = columns;
  }
  return <Box ref={setElement}>{cached.current}</Box>;
}
