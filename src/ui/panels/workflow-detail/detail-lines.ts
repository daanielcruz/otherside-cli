import type { WorkflowAgentProgress } from "@/engine/background/workflows/runtime/store/types.ts";
import type { AgentTranscriptToolCall } from "@/engine/background/workflows/runtime/transcript/types.ts";
import { formatDuration, formatTokens } from "@/kernel/std/text/format.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import { wrapText } from "@/kernel/std/text/wrapping.ts";
import type { AgentDisplayStatus } from "@/ui/chrome/progress/glyphs.ts";
import { Color } from "@/ui/theme/theme.ts";
import type { Segment } from "./segments.tsx";
import { statusIconColor, truncateToWidth } from "./segments.tsx";

const INDENT = "  ";
const MIDDOT = " · ";
const PROMPT_WIDTH_INSET = 2;
const PROMPT_WIDTH_FLOOR = 8;
const PROMPT_PREVIEW_MAX_LINES = 2;
const ACTIVITY_TAIL_COUNT = 3;

export const EXPAND_PROMPT_GLYPH = "\u23CE";

const AGENT_STATUS_LABELS: Record<AgentDisplayStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Completed",
  failed: "Failed",
  skipped: "Skipped",
  interrupted: "Stopped",
};

function promptPlaceholder(status: AgentDisplayStatus): string {
  if (status === "running") return "Not available yet (agent still running).";
  return "Transcript not available.";
}

function activityPlaceholder(status: AgentDisplayStatus): string {
  if (status === "running") return "No tool calls yet.";
  return "No tool calls.";
}

function buildPromptLines(input: {
  agent: WorkflowAgentProgress;
  status: AgentDisplayStatus;
  width: number;
  promptExpanded: boolean;
}): { lines: Segment[][]; promptExpandable: boolean } {
  const { agent, status, width, promptExpanded } = input;
  const promptWidth = Math.max(PROMPT_WIDTH_FLOOR, width - PROMPT_WIDTH_INSET);
  const promptText = agent.transcript?.prompt ?? agent.promptPreview ?? "";
  if (promptText.length === 0) {
    return {
      lines: [
        [{ text: "Prompt", bold: true, dim: true }],
        [{ text: INDENT + promptPlaceholder(status), dim: true }],
      ],
      promptExpandable: false,
    };
  }
  const wrapped = wrapText(promptText, promptWidth);
  const promptExpandable = wrapped.length > PROMPT_PREVIEW_MAX_LINES;
  const header: Segment[] = [{ text: "Prompt", bold: true, dim: true }];
  if (promptExpandable) {
    header.push({
      text: `${MIDDOT}${wrapped.length} lines${promptExpanded ? "" : `${MIDDOT}${EXPAND_PROMPT_GLYPH} expand`}`,
      dim: true,
    });
  }
  const lines: Segment[][] = [header];
  const visibleLines = promptExpanded ? wrapped : wrapped.slice(0, PROMPT_PREVIEW_MAX_LINES);
  for (const line of visibleLines) {
    lines.push([{ text: INDENT + line, dim: true }]);
  }
  if (promptExpandable && !promptExpanded) {
    const hiddenLines = wrapped.length - PROMPT_PREVIEW_MAX_LINES;
    lines.push([
      {
        text: `${INDENT}… ${hiddenLines} more ${pluralize(hiddenLines, "line")}`,
        dim: true,
      },
    ]);
  }
  return { lines, promptExpandable };
}

function toolCallLine(input: { call: AgentTranscriptToolCall; width: number }): Segment[] {
  const { call, width } = input;
  const summary = call.summary.length > 0 ? `(${call.summary})` : "";
  return [
    {
      text: truncateToWidth({ text: `${INDENT}${call.name}${summary}`, max: width }),
      dim: true,
    },
  ];
}

function buildActivityLines(input: {
  agent: WorkflowAgentProgress;
  status: AgentDisplayStatus;
  width: number;
}): Segment[][] {
  const { agent, status, width } = input;
  const toolCalls = agent.transcript?.toolCalls ?? [];
  const header: Segment[] = [{ text: "Activity", bold: true, dim: true }];
  if (toolCalls.length > ACTIVITY_TAIL_COUNT) {
    header.push({
      text: `${MIDDOT}last ${ACTIVITY_TAIL_COUNT} of ${toolCalls.length} tool calls`,
      dim: true,
    });
  }
  const lines: Segment[][] = [header];
  if (toolCalls.length > 0) {
    for (const call of toolCalls.slice(-ACTIVITY_TAIL_COUNT)) {
      lines.push(toolCallLine({ call, width }));
    }
    return lines;
  }
  if (agent.lastToolName != null) {
    lines.push(
      toolCallLine({
        call: { name: agent.lastToolName, summary: agent.lastToolSummary ?? "" },
        width,
      }),
    );
    return lines;
  }
  lines.push([{ text: INDENT + activityPlaceholder(status), dim: true }]);
  return lines;
}

function buildHeaderLine(input: {
  agent: WorkflowAgentProgress;
  status: AgentDisplayStatus;
  width: number;
}): Segment[] {
  const { agent, status, width } = input;
  const { glyph, color } = statusIconColor({ status });
  const meta: string[] = [];
  if (agent.model != null) meta.push(agent.model);
  if (agent.agentType != null) meta.push(agent.agentType);
  if (agent.cached === true) meta.push("from resume journal");
  if (agent.isolation != null) meta.push(agent.isolation);
  if (agent.attempt != null && agent.attempt > 1) {
    meta.push(
      agent.lastAttemptReason != null
        ? `attempt ${agent.attempt} (${agent.lastAttemptReason})`
        : `attempt ${agent.attempt}`,
    );
  }
  const label = AGENT_STATUS_LABELS[status];
  const headerWidth = glyph.length + 1 + label.length;
  const metaText =
    meta.length > 0
      ? truncateToWidth({
          text: `${MIDDOT}${meta.join(MIDDOT)}`,
          max: Math.max(0, width - headerWidth),
        })
      : "";
  const header: Segment[] = [
    { text: glyph, color },
    { text: " " },
    { text: label, color, bold: true },
  ];
  if (metaText.length > 0) header.push({ text: metaText, dim: true });
  return header;
}

function buildStatsLine(input: {
  agent: WorkflowAgentProgress;
  status: AgentDisplayStatus;
  width: number;
  nowMs: number;
}): Segment[] | null {
  const { agent, status, width, nowMs } = input;
  const stats: string[] = [];
  if (agent.tokens != null) stats.push(`${formatTokens(agent.tokens)} tok`);
  if (agent.toolCalls != null && agent.toolCalls > 0) {
    stats.push(`${agent.toolCalls} ${pluralize(agent.toolCalls, "tool call")}`);
  }
  if (status === "done") {
    stats.push(formatDuration(agent.lastProgressAt - agent.startedAt));
  } else if (status === "running" && nowMs > 0) {
    stats.push(formatDuration(Math.max(0, nowMs - agent.startedAt)));
  }
  if (stats.length === 0) return null;
  return [{ text: truncateToWidth({ text: stats.join(MIDDOT), max: width }), dim: true }];
}

function buildOutcomeBody(input: {
  agent: WorkflowAgentProgress;
  status: AgentDisplayStatus;
  width: number;
}): Segment[][] {
  const { agent, status, width } = input;
  const bodyWidth = Math.max(PROMPT_WIDTH_FLOOR, width - PROMPT_WIDTH_INSET);
  if (status === "running") return [[{ text: `${INDENT}Still running…`, dim: true }]];
  if (status === "interrupted") {
    return [[{ text: `${INDENT}The workflow stopped before this agent finished.`, dim: true }]];
  }
  if (status === "failed") {
    const detail = agent.transcript?.finalText ?? agent.resultPreview ?? "";
    if (detail.length === 0) return [[{ text: `${INDENT}failed`, color: Color.error }]];
    return wrapText(detail, bodyWidth).map((line) => [{ text: INDENT + line, color: Color.error }]);
  }
  if (status === "done") {
    const finalText = agent.transcript?.finalText ?? agent.resultPreview ?? "";
    if (finalText.length === 0) {
      return [[{ text: `${INDENT}(no captured output)`, dim: true }]];
    }
    return wrapText(finalText, bodyWidth).map((line) => [{ text: INDENT + line }]);
  }
  return [[{ text: "" }]];
}

export function buildAgentDetailLines(input: {
  agent: WorkflowAgentProgress;
  status: AgentDisplayStatus;
  width: number;
  nowMs: number;
  promptExpanded: boolean;
}): { lines: Segment[][]; promptExpandable: boolean } {
  const { agent, status, width, nowMs, promptExpanded } = input;
  const lines: Segment[][] = [];

  lines.push(buildHeaderLine({ agent, status, width }));

  const statsLine = buildStatsLine({ agent, status, width, nowMs });
  if (statsLine !== null) lines.push(statsLine);
  lines.push([{ text: "" }]);

  const promptResult = buildPromptLines({ agent, status, width, promptExpanded });
  for (const line of promptResult.lines) lines.push(line);
  lines.push([{ text: "" }]);

  for (const line of buildActivityLines({ agent, status, width })) lines.push(line);
  lines.push([{ text: "" }]);

  lines.push([{ text: "Outcome", bold: true, dim: true }]);
  for (const line of buildOutcomeBody({ agent, status, width })) lines.push(line);

  return { lines, promptExpandable: promptResult.promptExpandable };
}
