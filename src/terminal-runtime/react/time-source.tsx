import React, { createContext, useEffect, useState } from "react";
import { RENDER_CYCLE_INTERVAL_MS } from "@/terminal-runtime/host/timing.js";
import { useIsTerminalFocused } from "@/terminal-runtime/react/use-focus-state.js";

export type TimeKeeper = {
  subscribeKeepAlive: (onChange: () => void) => () => void;
  subscribeFollower: (onChange: () => void) => () => void;
  now: () => number;
  setTickInterval: (ms: number) => void;
  setTimeout: (callback: () => void, ms: number) => () => void;
};

export function createTimeKeeper(tickIntervalMs: number): TimeKeeper {
  const focusListeners = new Map<() => void, boolean>();
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentTickIntervalMs = tickIntervalMs;
  const startTime = performance.now();

  let tickTime = 0;

  function tick(): void {
    tickTime = performance.now() - startTime;
    for (const onChange of focusListeners.keys()) {
      onChange();
    }
  }

  function updateInterval(): void {
    const anyKeepAlive = [...focusListeners.values()].some(Boolean);

    if (anyKeepAlive) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      interval = setInterval(tick, currentTickIntervalMs);
    } else if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  function subscribe(onChange: () => void, keepAlive: boolean): () => void {
    focusListeners.set(onChange, keepAlive);
    updateInterval();
    return () => {
      focusListeners.delete(onChange);
      updateInterval();
    };
  }

  return {
    subscribeKeepAlive(onChange) {
      return subscribe(onChange, true);
    },

    subscribeFollower(onChange) {
      return subscribe(onChange, false);
    },

    now() {
      if (interval && tickTime) {
        return tickTime;
      }
      return performance.now() - startTime;
    },

    setTickInterval(ms) {
      if (ms === currentTickIntervalMs) return;
      currentTickIntervalMs = ms;
      updateInterval();
    },

    setTimeout(callback, ms) {
      const handle = setTimeout(callback, ms);
      return () => clearTimeout(handle);
    },
  };
}

export const TimekeeperContext = createContext<TimeKeeper | null>(null);

const UNFOCUSED_UPDATE_INTERVAL_MS = RENDER_CYCLE_INTERVAL_MS * 2;

export function TimekeeperProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const [clock] = useState(() => createTimeKeeper(RENDER_CYCLE_INTERVAL_MS));
  const focused = useIsTerminalFocused();

  useEffect(() => {
    clock.setTickInterval(focused ? RENDER_CYCLE_INTERVAL_MS : UNFOCUSED_UPDATE_INTERVAL_MS);
  }, [clock, focused]);

  return <TimekeeperContext.Provider value={clock}>{children}</TimekeeperContext.Provider>;
}
