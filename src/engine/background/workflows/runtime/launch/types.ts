export interface WorkflowInput {
  script?: unknown;
  name?: unknown;
  description?: unknown;
  title?: unknown;
  args?: unknown;
  scriptPath?: unknown;
  resumeFromRunId?: unknown;
}

export interface WorkflowLaunchResult {
  status: "async_launched";
  taskId: string;
  taskType: "local_workflow";
  workflowName: string;
  runId: string;
  summary: string;
  transcriptDir: string;
  scriptPath: string;
  sessionUrl?: string;
  warning?: string;
  error?: string;
}

export type WorkflowLaunchOutcome =
  | { ok: true; result: WorkflowLaunchResult; message: string }
  | { ok: false; error: string };
