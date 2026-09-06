import { tallyWorkflowProgress } from "@/engine/background/workflows/runtime/store/progress.ts";
import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import { INTERRUPTED_FEEDBACK } from "@/engine/queue/runtime/interruption-text.ts";
import { get as getToolHandler } from "@/engine/tools/registry.ts";
import { formatDuration, formatTokens } from "@/kernel/std/text/format.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import wrapText from "@/terminal-runtime/text/line-fold.js";
import { PAUSE_GLYPH, TICK, workflowPanelStatus } from "@/ui/chrome/progress/glyphs.ts";
import { formatElapsed } from "@/ui/chrome/progress/index.ts";
import { isFinalWorkflowStatus } from "@/ui/chrome/progress/workflow-row.ts";
import { Color, Glyph, GUTTER_CONT, GUTTER_HEAD } from "@/ui/theme/theme.ts";
import type { AgentChipDescriptor } from "@/ui/transcript/agent-chip-data.ts";
import { formatDurationMs } from "@/ui/transcript/agent-chip-data.ts";
import {
  foldOutputRows,
  outputFoldHint,
  type TranscriptPresentation,
  wrapOutputRows,
} from "@/ui/transcript/presentation.ts";
import {
  displayNameFor,
  displayRouteModelName,
  resolveArgBody,
  resolveArgSegments,
} from "@/ui/transcript/tool-render/args.ts";
import { renderDiffAnsiLines } from "@/ui/transcript/tool-render/diff.ts";
import { expandTabsForRender, wrapStyledRows } from "@/ui/transcript/tool-render/format.ts";
import { formatHeadRows } from "@/ui/transcript/tool-render/head.ts";
import { resolveToolLabel } from "@/ui/transcript/tool-render/label.ts";
import {
  isValidationFailureText,
  VALIDATION_FAILURE_LABEL,
} from "@/ui/transcript/tool-render/payload.ts";
import { bashOutputRows } from "@/ui/transcript/tool-render/shell-output.ts";
import type {
  ToolEntryData,
  ToolNestedEntry,
  ToolPayload,
  ToolStatus,
} from "@/ui/transcript/tool-render/types.ts";

const EOL = "\n";
const PROGRESS_MAX_LINES = 8;
const TERMINAL_CROSS = "✖";
const WORKFLOW_SUGGESTION = "/workflows";

type TextPayload = Extract<ToolPayload, { kind: "preview" | "progress" | "hint" }>;
type DiffPayload = Extract<ToolPayload, { kind: "diff" }>;
type BashPayload = Extract<ToolPayload, { kind: "bash" }>;
type WorkflowPayload = Extract<ToolPayload, { kind: "workflow" }>;

export { TOOL_PULSE_INTERVAL_MS } from "@/ui/transcript/tool-render/head.ts";
export type { ToolEntryData, ToolNestedEntry } from "@/ui/transcript/tool-render/types.ts";

export function formatToolLines(
  data: ToolEntryData,
  width: number,
  presentation: TranscriptPresentation = "compact",
): string[] {
  const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  if (presentation !== "detailed" && data.completionChip?.kind !== "backgrounded") {
    if (data.completionChip)
      return formatCompletionChip(data.completionChip, columns, presentation);
  }

  const head = formatHeadRows(data, columns, presentation);
  if (head.length === 0) return [];
  if (data.isBackgrounded) {
    const label =
      data.name === "Bash"
        ? "Running in the background (↓ to manage)"
        : "Backgrounded agent (↓ to manage)";
    return [...head, ...gutterRows([muted(label)], false)];
  }

  const nested = formatNestedRows(data.nested ?? [], columns, presentation);
  const initializing =
    data.name === "Agent" && data.status === "running" && nested.length === 0
      ? gutterRows([muted("Initializing…")], false)
      : [];
  const hasBodyPrelude = nested.length > 0 || initializing.length > 0;
  const payload = formatToolPayloadLines(
    data.payload,
    data.status,
    columns,
    presentation,
    hasBodyPrelude,
  );
  const runningBash =
    data.name === "Bash" && data.status === "running"
      ? formatBashRunningRows(data, hasBodyPrelude || payload.length > 0)
      : [];
  const agentHint =
    data.name === "Agent" && data.status === "running"
      ? gutterRows([muted(backgroundHintText())], true)
      : [];
  return [...head, ...initializing, ...nested, ...payload, ...runningBash, ...agentHint];
}

function formatNestedRows(
  entries: readonly ToolNestedEntry[],
  width: number,
  presentation: TranscriptPresentation,
): string[] {
  const visible = entries.filter((entry) => nestedDisplayName(entry).length > 0);
  const folded = foldOutputRows(visible, {
    expanded: presentation === "detailed",
    edge: "end",
  });
  const bodyWidth = Math.max(1, width - stringWidth(GUTTER_CONT));
  const rows = folded.visible.map((entry) => {
    const name = nestedDisplayName(entry);
    const body = nestedArgBody(entry);
    const label =
      renderTextWithStyles(name, { bold: true, color: Color.titleStrong }) +
      (body.length > 0 ? renderTextWithStyles(`(${body})`, { color: Color.toolBody }) : "");
    return wrapText(label, bodyWidth, "truncate-end");
  });
  const output = gutterRows(rows, false);
  if (folded.hidden > 0) {
    const plural = folded.hidden === 1 ? "use" : "uses";
    output.push(
      renderTextWithStyles(GUTTER_CONT, { color: Color.muted }) +
        muted(`+${folded.hidden} more tool ${plural} (ctrl+o to expand)`),
    );
  }
  return output;
}

function nestedDisplayName(entry: ToolNestedEntry): string {
  return resolveToolLabel({
    name: entry.toolName,
    args: entry.args,
    mcpIdentity: entry.mcpIdentity,
  });
}

function nestedArgBody(entry: ToolNestedEntry): string {
  if (entry.argumentLabel !== undefined) return entry.argumentLabel;
  const hooks = getToolHandler(entry.toolName)?.render;
  const segments = resolveArgSegments(hooks, entry.toolName, entry.args);
  return resolveArgBody({ name: entry.toolName, bashCommand: null, argSegments: segments });
}

export function formatToolPayloadLines(
  payload: ToolPayload | null,
  status: ToolStatus,
  width: number,
  presentation: TranscriptPresentation = "compact",
  suppressHead = false,
): string[] {
  if (payload?.kind === "diff") return diffPayloadRows(payload, width, suppressHead);
  if (payload?.kind === "bash") return bashPayloadRows(payload, status, width, suppressHead);
  if (payload?.kind === "interrupt") return interruptPayloadRows(suppressHead);
  if (payload?.kind === "workflow") return workflowPayloadRows(payload, suppressHead);

  const logical = payloadRows(collapseValidationFailure(payload, presentation), status);
  if (logical.length === 0) return [];
  const bodyWidth = Math.max(1, width - stringWidth(GUTTER_CONT));
  const physical = logical.flatMap((row) => wrapOutputRows(row, bodyWidth));
  const folded = foldOutputRows(physical, { expanded: presentation !== "compact" });
  const output = gutterRows(folded.visible, suppressHead);
  if (folded.hidden > 0) {
    output.push(
      renderTextWithStyles(GUTTER_CONT, { color: Color.muted }) +
        muted(outputFoldHint(folded.hidden)),
    );
  }
  return output;
}

function collapseValidationFailure(
  payload: ToolPayload | null,
  presentation: TranscriptPresentation,
): ToolPayload | null {
  if (presentation === "detailed") return payload;
  if (payload?.kind !== "preview" || !isValidationFailureText(payload.text)) return payload;
  return { kind: "preview", text: VALIDATION_FAILURE_LABEL };
}

function formatBashRunningRows(data: ToolEntryData, suppressHead: boolean): string[] {
  const rows: string[] = [];
  if (data.payload === null) {
    const elapsedSuffix =
      typeof data.elapsedMs === "number" ? ` (${formatElapsed(data.elapsedMs)})` : "";
    rows.push(...gutterRows([muted(`Running…${elapsedSuffix}`)], suppressHead));
  }
  rows.push(...gutterRows([muted(backgroundHintText())], true));
  return rows;
}

function diffPayloadRows(payload: DiffPayload, columns: number, suppressHead: boolean): string[] {
  const diffWidth = Math.max(1, columns - stringWidth(GUTTER_CONT));
  const ansi = renderDiffAnsiLines(payload.fragment, diffWidth, payload.filePath);
  if (ansi) {
    const headGutter = suppressHead ? GUTTER_CONT : GUTTER_HEAD;
    const firstRow =
      renderTextWithStyles(headGutter, { color: Color.muted }) +
      renderTextWithStyles(ansi.headerLines[0] ?? "", { color: Color.muted });
    const continuation = renderTextWithStyles(GUTTER_CONT, { color: Color.muted });
    return [firstRow, ...ansi.bodyLines.map((line) => continuation + line)];
  }

  return payload.fragment.split(EOL).map((row, index) => {
    let color = Color.muted;
    if (row.startsWith("+") && !row.startsWith("+++")) color = Color.success;
    else if (row.startsWith("-") && !row.startsWith("---")) color = Color.error;
    else if (row.startsWith("@@")) color = Color.highlight;
    const gutter = !suppressHead && index === 0 ? GUTTER_HEAD : GUTTER_CONT;
    return (
      renderTextWithStyles(gutter, { color: Color.muted }) + renderTextWithStyles(row, { color })
    );
  });
}

function bashPayloadRows(
  payload: BashPayload,
  status: ToolStatus,
  width: number,
  suppressHead: boolean,
): string[] {
  const rows = bashOutputRows(payload, width, status === "error");
  if (rows.length === 0) return [];
  const headGutter = suppressHead ? GUTTER_CONT : GUTTER_HEAD;
  return rows.map((row, index) => {
    const gutter = index === 0 || row.startsBlock === true ? headGutter : GUTTER_CONT;
    const color =
      row.tone === "error"
        ? Color.error
        : row.tone === "warning"
          ? Color.warning
          : row.tone === "muted"
            ? Color.muted
            : Color.toolBody;
    return (
      renderTextWithStyles(gutter, { color: Color.muted }) +
      renderTextWithStyles(row.text, { color })
    );
  });
}

function interruptPayloadRows(suppressHead: boolean): string[] {
  const gutter = suppressHead ? GUTTER_CONT : GUTTER_HEAD;
  return [
    renderTextWithStyles(gutter, { color: Color.muted }) +
      renderTextWithStyles(INTERRUPTED_FEEDBACK, { color: Color.muted }),
  ];
}

function workflowPayloadRows(payload: WorkflowPayload, suppressHead: boolean): string[] {
  const gutter = suppressHead ? GUTTER_CONT : GUTTER_HEAD;
  const line = formatWorkflowStatusLine(payload.task);
  return [renderTextWithStyles(gutter, { color: Color.muted }) + line];
}

function formatWorkflowStatusLine(task: WorkflowTaskLifecycle): string {
  if (isFinalWorkflowStatus(task.status)) return workflowTerminalLine(task);
  if (task.status === "paused") {
    return (
      renderTextWithStyles(`${PAUSE_GLYPH} `, { color: Color.warning }) +
      muted("Paused · ") +
      renderTextWithStyles(WORKFLOW_SUGGESTION, { color: Color.primaryGlow }) +
      muted(" for details")
    );
  }
  if (!hasReportedAgents(task)) {
    return (
      muted("Running in background · ") +
      renderTextWithStyles(WORKFLOW_SUGGESTION, { color: Color.primaryGlow }) +
      muted(" to monitor and save")
    );
  }
  return (
    muted("Running in background · ") +
    renderTextWithStyles(WORKFLOW_SUGGESTION, { color: Color.primaryGlow }) +
    muted(" for details")
  );
}

function workflowTerminalLine(task: WorkflowTaskLifecycle): string {
  const isError = task.status === "failed" || task.status === "killed";
  const totalTokens = sumAgentTokens(task);
  const progress = tallyWorkflowProgress(task.workflowProgress, task.agentCount);
  const durationText =
    task.endedAt && task.startedAt ? ` in ${formatDuration(task.endedAt - task.startedAt)}` : "";
  const agentText =
    progress.total > 0 ? ` · ${progress.total} ${pluralize(progress.total, "agent")}` : "";
  const tokensText = totalTokens > 0 ? ` · ${formatTokens(totalTokens)} tokens` : "";
  const glyph = isError ? TERMINAL_CROSS : TICK;
  const glyphColor = isError ? Color.error : Color.success;
  const label = terminalWorkflowLabel(task.status);
  return (
    renderTextWithStyles(`${glyph} `, { color: glyphColor }) +
    muted(`${label}${durationText}${agentText}${tokensText}`)
  );
}

function terminalWorkflowLabel(status: WorkflowTaskLifecycle["status"]): string {
  const panelStatus = workflowPanelStatus(status) ?? "done";
  return panelStatus.charAt(0).toUpperCase() + panelStatus.slice(1);
}

function hasReportedAgents(task: WorkflowTaskLifecycle): boolean {
  return task.workflowProgress.some((entry) => entry.type === "workflow_agent");
}

function sumAgentTokens(task: WorkflowTaskLifecycle): number {
  let totalTokens = 0;
  for (const entry of task.workflowProgress) {
    if (entry.type === "workflow_agent" && entry.tokens) totalTokens += entry.tokens;
  }
  return totalTokens === 0 ? task.totalTokens : totalTokens;
}

function payloadRows(payload: ToolPayload | null, status: ToolStatus): string[] {
  if (payload === null) return [];
  switch (payload.kind) {
    case "preview":
    case "progress":
    case "hint":
      return textPayloadRows(payload, status === "error");
    case "diff":
      return [renderTextWithStyles(payload.fragment, { color: Color.toolBody })];
    case "bash":
    case "interrupt":
    case "workflow":
      return [];
    case "findings":
      return payload.findings.flatMap((finding) => {
        const verdict =
          finding.verdict === "CONFIRMED"
            ? renderTextWithStyles(" CONFIRMED", { color: Color.error })
            : finding.verdict === "PLAUSIBLE"
              ? renderTextWithStyles(" PLAUSIBLE", { color: Color.warning })
              : "";
        const outcome = finding.outcome
          ? renderTextWithStyles(` [${finding.outcome}]`, { color: Color.muted })
          : "";
        return [
          renderTextWithStyles(`${finding.file}:${finding.line} — ${finding.summary}`, {
            color: Color.toolBody,
          }) +
            verdict +
            outcome,
          renderTextWithStyles(` ${finding.failure_scenario}`, { color: Color.muted }),
        ];
      });
  }
}

function textPayloadRows(payload: TextPayload, isError: boolean): string[] {
  const allRows = payload.text
    .replace(/\n+$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .split(EOL);
  let rows = allRows;
  if (payload.kind === "progress" && allRows.length > PROGRESS_MAX_LINES) {
    const overflow = allRows.length - PROGRESS_MAX_LINES;
    rows = [...allRows.slice(overflow), `… +${overflow} lines`];
  }
  const color =
    payload.kind === "progress" || payload.kind === "hint"
      ? Color.muted
      : isError
        ? Color.error
        : Color.toolBody;
  return rows.map((row) => renderTextWithStyles(expandTabsForRender(row), { color }));
}

function formatCompletionChip(
  chip: AgentChipDescriptor,
  width: number,
  presentation: TranscriptPresentation,
): string[] {
  const label = chip.taskKind === "shell" ? "Background command" : "Agent";
  const fallbackName = chip.subagentType
    ? displayNameFor("Agent", { subagent_type: chip.subagentType })
    : label;
  const description = chip.description || fallbackName;
  const routeLabel = completionRouteLabel(chip);
  const modelText = routeLabel ? ` ${routeLabel}` : "";
  const stats = completionStats(chip);
  const verb = chip.kind === "stopped" ? "was stopped" : chip.kind;
  const id = chip.kind === "stopped" ? ` #${chip.id}` : "";
  const headline = `${label} "${description}"${id}${modelText} ${verb}${stats ? ` ${stats}` : ""}`;
  const color =
    chip.kind === "failed"
      ? Color.error
      : chip.kind === "completed"
        ? Color.success
        : chip.kind === "running"
          ? Color.highlight
          : Color.muted;
  const rows = prefixWrappedRows(headline, width, `${Glyph.bullet} `, color, Color.text);
  if (chip.kind !== "failed" || !chip.reason) return rows;

  const bodyWidth = Math.max(1, width - stringWidth(GUTTER_CONT));
  const reasonRows = wrapOutputRows(
    renderTextWithStyles(chip.reason, { color: Color.error }),
    bodyWidth,
  );
  const folded = foldOutputRows(reasonRows, { expanded: presentation !== "compact" });
  rows.push(...gutterRows(folded.visible, false));
  if (folded.hidden > 0) {
    rows.push(
      renderTextWithStyles(GUTTER_CONT, { color: Color.muted }) +
        muted(outputFoldHint(folded.hidden)),
    );
  }
  return rows;
}

function completionRouteLabel(chip: AgentChipDescriptor): string {
  const route = chip.modelRoute ?? chip.producedRoute;
  if (route) return displayRouteModelName(route);
  return chip.model ?? chip.producedModel ?? "";
}

function completionStats(chip: AgentChipDescriptor): string {
  const parts: string[] = [];
  if (typeof chip.exitCode === "number") parts.push(`exit code ${chip.exitCode}`);
  if (typeof chip.toolUses === "number") {
    parts.push(`${chip.toolUses} tool use${chip.toolUses === 1 ? "" : "s"}`);
  }
  if (typeof chip.tokens === "number" && chip.tokens > 0) {
    parts.push(`${formatNumberCompact(chip.tokens)} tokens`);
  }
  if (typeof chip.durationMs === "number" && chip.durationMs > 0) {
    parts.push(formatDurationMs(chip.durationMs));
  }
  return parts.length > 0 ? `(${parts.join(" · ")})` : "";
}

function formatNumberCompact(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function prefixWrappedRows(
  text: string,
  width: number,
  prefix: string,
  prefixColor: (typeof Color)[keyof typeof Color],
  bodyColor: (typeof Color)[keyof typeof Color],
): string[] {
  const bodyWidth = Math.max(1, width - stringWidth(prefix));
  const bodyStyles = bodyColor === undefined ? {} : { color: bodyColor };
  const prefixStyles =
    prefixColor === undefined ? { bold: true } : { color: prefixColor, bold: true };
  const body = wrapStyledRows(renderTextWithStyles(text, bodyStyles), bodyWidth);
  const styledPrefix = renderTextWithStyles(prefix, prefixStyles);
  const continuation = " ".repeat(stringWidth(prefix));
  return body.map((line, index) => `${index === 0 ? styledPrefix : continuation}${line}`);
}

function gutterRows(rows: readonly string[], suppressHead: boolean): string[] {
  return rows.map((row, index) => {
    const gutter = !suppressHead && index === 0 ? GUTTER_HEAD : GUTTER_CONT;
    return renderTextWithStyles(gutter, { color: Color.muted }) + row;
  });
}

function backgroundHintText(): string {
  return process.env.TMUX !== undefined
    ? "(ctrl+b ctrl+b (twice) to run in background)"
    : "(ctrl+b to run in background)";
}

function muted(text: string): string {
  return renderTextWithStyles(text, { color: Color.muted });
}
