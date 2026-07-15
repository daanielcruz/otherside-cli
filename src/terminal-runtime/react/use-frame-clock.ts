import { useContext, useRef, useSyncExternalStore } from "react";
import { RENDER_CYCLE_INTERVAL_MS } from "@/terminal-runtime/host/timing.js";
import { TimekeeperContext } from "@/terminal-runtime/react/time-source.js";
import { useTerminalFocusState } from "@/terminal-runtime/react/use-focus-state.js";
import { useVisibleRegion } from "@/terminal-runtime/react/use-visible-region.js";
import type { TreeElement } from "@/terminal-runtime/tree/elements.js";

const noopSubscribe = (): (() => void) => () => {};

export function useFrameClock(
  intervalMs: number | null = 16,
): [ref: (element: TreeElement | null) => void, time: number] {
  const clock = useContext(TimekeeperContext);
  const [viewportRef, { isVisible }, recomputeVisibility] = useVisibleRegion();
  const paneState = useTerminalFocusState();

  const lastFocusState = useRef(paneState);
  let visible = isVisible;
  if (lastFocusState.current !== paneState) {
    lastFocusState.current = paneState;
    visible = recomputeVisibility().isVisible;
  }

  const active = !!clock && visible && intervalMs !== null;
  const quantum =
    intervalMs === null
      ? null
      : Math.ceil(intervalMs / RENDER_CYCLE_INTERVAL_MS) * RENDER_CYCLE_INTERVAL_MS;

  const timeRef = useRef(0);
  const time = useSyncExternalStore(active ? clock!.subscribeKeepAlive : noopSubscribe, () => {
    if (!active) return timeRef.current;
    const nextTime = Math.floor(clock!.now() / quantum!) * quantum!;
    if (nextTime <= timeRef.current) return timeRef.current;

    const position = recomputeVisibility();
    if (!position.isVisible || position.topClipped) return timeRef.current;
    return (timeRef.current = Math.max(timeRef.current, nextTime));
  });

  return [viewportRef, time];
}
