import { useCallback, useState } from "react";
import { useRepeatingClock } from "@/ink";
import { getIsScrollDraining } from "@/kernel/std/state/scroll-activity.ts";

export function useGoalTicker(intervalMs = 60_000): number {
  const [tick, setTick] = useState(0);
  const onTick = useCallback((): void => {
    if (getIsScrollDraining()) return;
    setTick((n) => n + 1);
  }, []);
  useRepeatingClock(onTick, intervalMs);
  return tick;
}
