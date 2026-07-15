import { useState } from "react";
import { useTerminalDimensions } from "@/ink";
import { useDisposableInterval } from "@/ui/panels/use-disposable-interval";
import type { WorkflowDetailItem } from "../types";
import { LIVE_TICK_MS, WIDTH_FLOOR, WIDTH_MARGIN } from "./constants.ts";

export function useWorkflowDetailLayout(): {
  availableRows: number;
  width: number;
  rows: number;
  columns: number;
} {
  const { rows, columns } = useTerminalDimensions();
  const width = Math.max(WIDTH_FLOOR, columns - WIDTH_MARGIN);
  return { availableRows: rows, width, rows, columns };
}

export function useWorkflowElapsed(input: { item: WorkflowDetailItem }): number {
  const { item } = input;
  const running = item.status === "running";
  const [now, setNow] = useState(() => Date.now());
  useDisposableInterval(() => setNow(Date.now()), LIVE_TICK_MS, { active: running });
  if (running) return Math.max(0, now - item.startTime);
  return item.durationMs;
}
