import type { WorkflowProgressEntry } from "@/engine/background/workflows/runtime/store/types.ts";

export interface WorkflowProgressSummary {
  done: number;
  failedCount: number;
  stoppedCount: number;
  running: boolean;
  total: number;
  complete: boolean;
}

export function computeWorkflowProgress(
  events: WorkflowProgressEntry[],
  agentCount = 0,
): WorkflowProgressSummary {
  let seen = 0;
  let done = 0;
  let failedCount = 0;
  let stoppedCount = 0;
  let running = false;
  for (const event of events) {
    if (event.type !== "workflow_agent") continue;
    seen++;
    if (event.state === "done") {
      done++;
    } else if (event.state === "error") {
      if (event.stopped === true) {
        stoppedCount++;
      } else {
        failedCount++;
      }
    } else {
      running = true;
    }
  }
  const total = Math.max(agentCount, seen);
  const complete = !running && seen > 0 && done + failedCount + stoppedCount >= total;
  return { done, failedCount, stoppedCount, running, total, complete };
}
