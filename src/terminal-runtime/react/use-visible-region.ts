import { useCallback, useContext, useLayoutEffect, useRef } from "react";
import { TerminalSizeContext } from "@/terminal-runtime/react/dimensions-context.js";
import type { TreeElement } from "@/terminal-runtime/tree/elements.js";

type LayoutVisibilityState = {
  isVisible: boolean;

  topClipped: boolean;
};

export function useVisibleRegion(): [
  ref: (element: TreeElement | null) => void,
  entry: LayoutVisibilityState,
  recompute: () => LayoutVisibilityState,
] {
  const displayDimensions = useContext(TerminalSizeContext);
  const elementRef = useRef<TreeElement | null>(null);
  const entryRef = useRef<LayoutVisibilityState>({ isVisible: true, topClipped: false });

  const setElement = useCallback((el: TreeElement | null) => {
    elementRef.current = el;
  }, []);

  function computeVisible(): LayoutVisibilityState {
    const element = elementRef.current;
    if (!element?.yogaNode || !displayDimensions) {
      return entryRef.current;
    }

    const height = element.yogaNode.getComputedHeight();
    const rows = displayDimensions.rows;

    let absoluteTop = element.yogaNode.getComputedTop();
    let parent: TreeElement | undefined = element.parentNode;
    let root = element.yogaNode;
    while (parent) {
      if (parent.yogaNode) {
        absoluteTop += parent.yogaNode.getComputedTop();
        root = parent.yogaNode;
      }
      parent = parent.parentNode;
    }

    const screenHeight = root.getComputedHeight();

    const bottom = absoluteTop + height;
    const scrollCompensationOffset = screenHeight > rows ? 1 : 0;
    const viewportY = Math.max(0, screenHeight - rows) + scrollCompensationOffset;
    const viewportBottom = viewportY + rows;
    const visible = bottom > viewportY && absoluteTop < viewportBottom;
    const topClipped = visible && absoluteTop < viewportY;

    if (visible !== entryRef.current.isVisible || topClipped !== entryRef.current.topClipped) {
      entryRef.current = { isVisible: visible, topClipped };
    }
    return entryRef.current;
  }

  const computeRef = useRef(computeVisible);
  computeRef.current = computeVisible;
  const recompute = useCallback(() => computeRef.current(), []);

  useLayoutEffect(() => {
    computeVisible();
  });

  return [setElement, entryRef.current, recompute];
}
