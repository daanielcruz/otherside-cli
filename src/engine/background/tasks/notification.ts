export type TaskNotificationStatus = "completed" | "failed" | "killed";

export type TaskKind = "agent" | "shell";

export interface CompletionNotificationUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
  /** When set, emit workflow-style usage tags (`agent_count` / `subagent_tokens`). */
  agentCount?: number;
  agents?: {
    done: number;
    error: number;
    skipped: number;
    emptyResult: number;
  };
}

export interface CompletionNotificationInput {
  taskId: string;
  toolUseId?: string;
  outputFile?: string;
  status: TaskNotificationStatus;
  summary: string;
  result?: string;
  /** Model-facing resume guidance (failed/killed workflows). */
  recovery?: string;
  /** Model-facing journal pointer + re-run guidance (completed workflows). */
  diagnostics?: string;
  /** Per-agent failure lines collected during the run. */
  failures?: string[];
  usage?: CompletionNotificationUsage;
}

export interface StallNotificationInput {
  taskId: string;
  toolUseId?: string;
  outputFile: string;
  summary: string;
  tail: string;
}

// Notification field text is emitted raw. These are plain text content between tags, not attribute values, so quotes and angle brackets pass through without HTML escaping. Kept as a named seam so the single call site is obvious.
export function escapeXml(s: string): string {
  return s;
}

export interface SummaryOptions {
  error?: string;
  exitCode?: number;
  byUser?: boolean;
}

// Launch receipt returned inline when an Agent call detaches. Main and nested
// launches must hand the model the same contract: task id, notification
// promise, and the anti-duplication instruction.
export function buildAgentLaunchReceipt(agentId: string): string {
  return `Async agent launched successfully.\nagentId: ${agentId}\nThe agent is working in the background. You will be notified automatically when it completes.\nDo not duplicate this agent's work. Continue independent, non-overlapping work from the user's request. If no such work remains, briefly tell the user what you launched and end your response. Do not wait or poll; you will receive a completion notification.`;
}

function stoppedSuffix(byUser?: boolean): string {
  return byUser === true ? " by the user" : "";
}

export function buildAgentSummary(
  description: string,
  status: TaskNotificationStatus,
  options: SummaryOptions = {},
): string {
  const desc = description.length > 0 ? description : "(no description)";
  if (status === "completed") return `Agent "${desc}" completed`;
  if (status === "killed") return `Agent "${desc}" was stopped${stoppedSuffix(options.byUser)}`;
  return `Agent "${desc}" failed${options.error ? `: ${options.error}` : ""}`;
}

export function buildWorkflowSummary(
  description: string,
  status: TaskNotificationStatus,
  options: SummaryOptions = {},
): string {
  const desc = description.length > 0 ? description : "(no description)";
  if (status === "completed") return `Dynamic workflow "${desc}" completed`;
  if (status === "killed")
    return `Dynamic workflow "${desc}" was stopped${stoppedSuffix(options.byUser)}`;
  return `Dynamic workflow "${desc}" failed${options.error ? `: ${options.error}` : ""}`;
}

export function buildBashSummary(
  description: string,
  status: TaskNotificationStatus,
  options: SummaryOptions = {},
): string {
  const desc = description.length > 0 ? description : "(no description)";
  if (status === "killed")
    return `Background command "${desc}" was stopped${stoppedSuffix(options.byUser)}`;
  const tail = options.exitCode !== undefined ? ` (exit code ${options.exitCode})` : "";
  if (status === "completed") return `Background command "${desc}" completed${tail}`;
  return `Background command "${desc}" failed${tail}`;
}

export function buildCompletionNotification(input: CompletionNotificationInput): string {
  const lines: string[] = ["<task-notification>"];
  lines.push(`<task-id>${input.taskId}</task-id>`);
  if (input.toolUseId !== undefined) {
    lines.push(`<tool-use-id>${input.toolUseId}</tool-use-id>`);
  }
  if (input.outputFile !== undefined) {
    lines.push(`<output-file>${input.outputFile}</output-file>`);
  }
  lines.push(`<status>${input.status}</status>`);
  lines.push(`<summary>${escapeXml(input.summary)}</summary>`);
  if (input.recovery !== undefined && input.recovery.length > 0) {
    lines.push(`<recovery>${escapeXml(input.recovery)}</recovery>`);
  }
  if (input.result !== undefined && input.result.length > 0) {
    lines.push(`<result>${escapeXml(input.result)}</result>`);
  }
  if (input.diagnostics !== undefined && input.diagnostics.length > 0) {
    lines.push(`<diagnostics>${escapeXml(input.diagnostics)}</diagnostics>`);
  }
  if (input.failures !== undefined && input.failures.length > 0) {
    lines.push(`<failures>${escapeXml(input.failures.join("\n"))}</failures>`);
  }
  if (input.usage !== undefined) {
    lines.push(formatUsageSection(input.usage));
  }
  lines.push("</task-notification>");
  return lines.join("\n");
}

function formatUsageSection(usage: CompletionNotificationUsage): string {
  if (usage.agentCount !== undefined) {
    const agents =
      usage.agents !== undefined
        ? `<agents_done>${usage.agents.done}</agents_done><agents_error>${usage.agents.error}</agents_error><agents_skipped>${usage.agents.skipped}</agents_skipped><agents_empty_result>${usage.agents.emptyResult}</agents_empty_result>`
        : "";
    return `<usage><agent_count>${usage.agentCount}</agent_count>${agents}<subagent_tokens>${usage.totalTokens}</subagent_tokens><tool_uses>${usage.toolUses}</tool_uses><duration_ms>${usage.durationMs}</duration_ms></usage>`;
  }
  return `<usage><total_tokens>${usage.totalTokens}</total_tokens><tool_uses>${usage.toolUses}</tool_uses><duration_ms>${usage.durationMs}</duration_ms></usage>`;
}

// Model-facing wrapper only — persisted records and the resume path keep the
// raw XML; wrap at send time so a notification is never mistaken for user
// acknowledgement of a pending question.
export function wrapNotificationForModel(raw: string): string {
  return `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\n\n${raw}\n</system-reminder>`;
}

export function buildStallNotification(input: StallNotificationInput): string {
  const lines: string[] = ["<task-notification>", `<task-id>${input.taskId}</task-id>`];
  if (input.toolUseId !== undefined) {
    lines.push(`<tool-use-id>${input.toolUseId}</tool-use-id>`);
  }
  lines.push(`<output-file>${input.outputFile}</output-file>`);
  lines.push(`<summary>${escapeXml(input.summary)}</summary>`);
  lines.push("</task-notification>");
  lines.push("Last output:");
  lines.push(input.tail.trimEnd());
  lines.push("");
  lines.push(
    "The command is likely blocked on an interactive prompt. Kill this task and re-run with piped input (e.g., `echo y | command`) or a non-interactive flag if one exists.",
  );
  return lines.join("\n");
}
