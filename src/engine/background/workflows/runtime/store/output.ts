import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import type { WorkflowTaskStatus } from "@/kernel/channels/workflow-tasks.ts";

export function formatWorkflowTaskOutput(
  task: WorkflowTaskLifecycle,
  overrides: { status?: WorkflowTaskStatus; result?: unknown; error?: string } = {},
): string {
  const status = overrides.status ?? task.status;
  const result = overrides.result ?? task.result;
  const error = overrides.error ?? task.error;
  const lines: string[] = [
    `Workflow: ${task.title ?? task.workflowName}`,
    `Run ID: ${task.workflowRunId}`,
    `Status: ${status}`,
  ];
  const summaryLine = summaryFor(task, status);
  if (summaryLine !== null) lines.push(`Summary: ${summaryLine}`);
  if (task.logs.length > 0) {
    lines.push("", "Logs:", ...task.logs);
  }
  if (task.degradedRouting && task.degradedRouting.length > 0) {
    lines.push("", "Degraded Routing:", ...task.degradedRouting.map((r) => `- ${r}`));
  }
  if (status === "completed") {
    lines.push(
      "",
      "Result:",
      result !== undefined ? formatWorkflowValue(result) : "(workflow returned no value)",
    );
  } else if (result !== undefined) {
    lines.push("", "Result:", formatWorkflowValue(result));
  }
  if (error !== undefined && error.length > 0) {
    lines.push("", "Error:", error);
  }
  return lines.join("\n");
}

function summaryFor(task: WorkflowTaskLifecycle, status: WorkflowTaskStatus): string | null {
  const name = task.title ?? task.workflowName;
  switch (status) {
    case "completed":
      return `Workflow "${name}" completed.`;
    case "failed":
      return `Workflow "${name}" failed.`;
    case "killed":
      return `Workflow "${name}" was stopped.`;
    default:
      return task.summary !== undefined && task.summary.length > 0 ? task.summary : null;
  }
}

function formatWorkflowValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
