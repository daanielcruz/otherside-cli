import { completeTask, get } from "./background.ts";

// A subagent stays parked while it still owns a running background shell, so a
// shell that never exits strands its owner with no way out. Agent-owned shells
// are therefore hard-capped: at the cap the process tree is killed through the
// same path an explicit stop uses and the task is marked killed, which releases
// the owner through the normal completion notification.
//
// Main-session shells carry no cap on purpose — the session that started them
// is still there to stop them.
export const SUBAGENT_SHELL_CAP_MS = 3_600_000;

export const SUBAGENT_SHELL_CAP_REASON = "Stopped at the agent background-shell time cap";

const CAP_ENV_VAR = "OTHERSIDE_SUBAGENT_BG_SHELL_TIMEOUT_MS";

export function subagentShellCapMs(): number {
  const configured = process.env[CAP_ENV_VAR];
  if (!configured) return SUBAGENT_SHELL_CAP_MS;
  const parsed = Number.parseInt(configured, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SUBAGENT_SHELL_CAP_MS;
}

export interface SubagentShellCapOptions {
  taskId: string;
  // Owning agent id; a main-session shell (undefined) is never capped.
  ownerId?: string | undefined;
  // Kills the shell process itself; the cap then marks the task killed, which
  // notifies through the normal completion path.
  kill: () => void;
  capMs?: number;
}

export function startSubagentShellCap(opts: SubagentShellCapOptions): () => void {
  if (opts.ownerId === undefined) return () => {};
  const timer = setTimeout(() => {
    const task = get(opts.taskId);
    if (task === undefined || task.status !== "running") return;
    opts.kill();
    completeTask(opts.taskId, {
      content: SUBAGENT_SHELL_CAP_REASON,
      isError: false,
      killed: true,
    });
  }, opts.capMs ?? subagentShellCapMs());
  (timer as { unref?: () => void }).unref?.();
  let stopped = false;
  return (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
  };
}
