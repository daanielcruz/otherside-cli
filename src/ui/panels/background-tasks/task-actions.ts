import {
  type BackgroundTask,
  completeTask,
  stopTaskForUser,
} from "@/engine/background/tasks/background.ts";
import { killBackground } from "@/engine/tools/builtins/bash.ts";

export function killTask(task: BackgroundTask): void {
  if (task.kind === "shell") {
    killBackground(task.id);
    completeTask(task.id, {
      content: "Killed by user",
      isError: false,
      killed: true,
      userInitiated: true,
    });
    return;
  }
  stopTaskForUser(task);
}

/**
 * The stop-all chord's reach: live agent runs and nothing else. A shell keeps its
 * process — the hint offered to stop agents, and a background shell outlives the
 * agent that started it.
 */
export function killAllRunningAgents(tasks: BackgroundTask[]): number {
  let killed = 0;
  for (const task of tasks) {
    if (task.kind === "agent" && task.status === "running") {
      killTask(task);
      killed += 1;
    }
  }
  return killed;
}
