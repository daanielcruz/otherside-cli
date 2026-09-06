import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkflowPhaseSpec } from "@/engine/background/workflows/runtime/parser/types.ts";
import type {
  WorkflowProgressItem,
  WorkflowTaskLifecycle,
} from "@/engine/background/workflows/runtime/store/types.ts";
import { sessionsRootForCwd } from "@/engine/session/paths.ts";
import type { WorkflowTaskStatus } from "@/kernel/channels/workflow-tasks.ts";

export interface WorkflowSnapshot {
  runId: string;
  workflowRunId?: string | undefined;
  taskId: string;
  timestamp: string;
  script: string;
  scriptPath?: string | undefined;
  args?: unknown | undefined;
  result?: unknown | undefined;
  agentCount: number;
  logs: string[];
  durationMs: number;
  error?: string | undefined;
  summary?: string | undefined;
  workflowName?: string | undefined;
  title?: string | undefined;
  status: WorkflowTaskStatus;
  startTime: number;
  phases?: WorkflowPhaseSpec[] | undefined;
  defaultModel?: string | undefined;
  workflowProgress: WorkflowProgressItem[];
  totalTokens: number;
  totalToolCalls: number;
}

export function workflowSnapshotsDir(cwd: string, sessionId: string): string {
  return join(sessionsRootForCwd(cwd), sessionId, "workflows");
}

export function workflowSnapshotPath(cwd: string, sessionId: string, runId: string): string {
  return join(workflowSnapshotsDir(cwd, sessionId), `${runId}.json`);
}

export async function readWorkflowSnapshot(options: {
  cwd: string;
  sessionId: string;
  runId: string;
}): Promise<WorkflowSnapshot | null> {
  const path = workflowSnapshotPath(options.cwd, options.sessionId, options.runId);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function persistWorkflowRun(options: {
  cwd: string;
  sessionId: string;
  runId: string;
  task: WorkflowTaskLifecycle;
}): Promise<void> {
  const { cwd, sessionId, runId, task } = options;
  try {
    const path = workflowSnapshotPath(cwd, sessionId, runId);
    const durationMs = task.endedAt ? task.endedAt - task.startedAt : Date.now() - task.startedAt;
    const snapshot: WorkflowSnapshot = {
      runId,
      workflowRunId: task.workflowRunId,
      taskId: task.id,
      timestamp: new Date().toISOString(),
      script: task.script ?? "",
      scriptPath: task.scriptPath,
      args: task.args,
      result: task.result,
      agentCount: task.agentCount,
      logs: task.logs,
      durationMs,
      error: task.error,
      summary: task.summary,
      workflowName: task.workflowName,
      title: task.title,
      status:
        task.status === "running"
          ? "running"
          : task.status === "paused"
            ? "paused"
            : task.status === "killed"
              ? "killed"
              : task.status === "completed"
                ? "completed"
                : "failed",
      startTime: task.startedAt,
      phases: task.phases,
      workflowProgress: task.workflowProgress,
      totalTokens: task.totalTokens,
      totalToolCalls: task.totalToolCalls,
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(snapshot, null, 2), "utf8");
  } catch {}
}

export async function loadWorkflowHistory(
  cwd: string,
  sessionId: string,
): Promise<WorkflowSnapshot[]> {
  const dir = workflowSnapshotsDir(cwd, sessionId);
  try {
    const entries = await readdir(dir);
    const jsonFiles = entries.filter((name) => name.endsWith(".json"));
    const list = await Promise.all(
      jsonFiles.map(async (name) => {
        try {
          const raw = await readFile(join(dir, name), "utf8");
          return JSON.parse(raw) as WorkflowSnapshot;
        } catch {
          return null;
        }
      }),
    );
    const valid = list.filter((item): item is WorkflowSnapshot => item !== null);
    return valid.sort((a, b) => b.startTime - a.startTime);
  } catch {
    return [];
  }
}
