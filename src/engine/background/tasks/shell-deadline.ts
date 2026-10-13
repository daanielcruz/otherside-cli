import { formatDurationCompact } from "@/kernel/std/text/format.ts";
import { completeTask, get } from "./background.ts";

// Every background shell runs under a time limit. A shell still running when
// the limit passes is killed through the same path an explicit stop uses, and
// its task is marked killed at the deadline, which notifies the model with the
// deadline summary and note.
export const SHELL_DEADLINE_REASON = "Stopped at its background time limit";

export interface ShellDeadlineOptions {
  taskId: string;
  limitMs: number;
  // Kills the shell process itself; the deadline then marks the task killed.
  kill: () => void;
}

export function startShellDeadline(opts: ShellDeadlineOptions): () => void {
  const timer = setTimeout(() => {
    const task = get(opts.taskId);
    if (task === undefined || task.status !== "running") return;
    if (!task.isBackgrounded || task.notified) return;
    opts.kill();
    completeTask(opts.taskId, {
      content: SHELL_DEADLINE_REASON,
      isError: false,
      killed: true,
      stopCause: "deadline",
    });
  }, opts.limitMs);
  // An unref'd timer never fires on Windows while nothing else holds the loop.
  if (process.platform !== "win32") timer.unref();
  let stopped = false;
  return (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
  };
}

// Told to the model when a running command is moved to the background.
export function shellDeadlineNotice(limitMs: number): string {
  return `If it is still running after ${formatDurationCompact(limitMs)} in the background, it will be stopped and you will be notified.`;
}
