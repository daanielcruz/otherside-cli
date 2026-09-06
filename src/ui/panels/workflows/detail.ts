import {
  type MergedPhase,
  renderWorkflowHeader,
  tallyWorkflowAgentCounts,
} from "@/engine/background/workflows/runtime/progress/merge.ts";
import type { WorkflowAgentStatus } from "@/engine/background/workflows/runtime/store/types.ts";
import { clamp } from "@/kernel/std/math.ts";
import { formatDuration, formatTokens } from "@/kernel/std/text/format.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import { wrapAnsi, wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { wrapText } from "@/terminal-runtime/text/plain-wrap.ts";
import { type AgentDisplayStatus, agentStatusGlyph } from "@/ui/chrome/progress/glyphs.ts";
import {
  type FooterPanelSpec,
  footerPanelBodyBudget,
  listOverflowLine,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import type { DetailLevel } from "@/ui/panels/types.ts";
import {
  type AgentFilter,
  agentFilterLabel,
  filterAgents,
} from "@/ui/panels/workflows/agent-filter.ts";
import {
  AGENT_PANE_WIDTH,
  agentPaneRows,
  BOX_RULE_ROWS as BOX_RULES,
  canSplitDetail,
  cardPaneWidth,
  PHASE_PANE_WIDTH,
  phasePaneRows,
  phasePaneTitle,
  renderDetailPanes,
} from "@/ui/panels/workflows/detail-panes.ts";
import {
  agentIdleSeconds,
  agentRowMeta,
  agentStatusLabel,
  isPromptExpandable,
  META_SEPARATOR,
  mergedPhases,
  PROMPT_PREVIEW_MAX_LINES,
  phaseGlyph,
  type WorkflowListItem,
} from "@/ui/panels/workflows/items.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const CONTENT_PAD = 2;
const DETAIL_ROW_WIDTH = 16;
const ACTIVITY_TAIL_COUNT = 3;
/** Agents previewed under the phase list; the agent level carries the whole set. */
const PHASE_AGENT_PREVIEW_COUNT = 4;
const PROMPT_CLIP = 1200;
const OUTCOME_CLIP = 800;

const AGENT_STATUS_LABELS: Record<AgentDisplayStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Completed",
  failed: "Failed",
  skipped: "Skipped",
  interrupted: "Stopped",
};

/** What the viewer is looking at; the panel owns it, the render only reads it. */
export interface DetailViewState {
  detailLevel: DetailLevel;
  phaseCursor: number;
  agentCursor: number;
  cardScroll: number;
  expandedPrompts: ReadonlySet<string>;
  agentFilter: AgentFilter;
}

/** Cursors come back clamped to what this workflow actually holds. */
export interface DetailRender {
  lines: string[];
  phaseCursor: number;
  agentCursor: number;
  cardScroll: number;
}

export function renderWorkflowDetail(input: {
  item: WorkflowListItem;
  state: DetailViewState;
  terminalRows: number;
  width: number;
}): DetailRender {
  const { item, state } = input;
  const contentWidth = Math.max(1, input.width - CONTENT_PAD * 2);
  const phases = mergedPhases(item);
  const phaseCursor = clamp(state.phaseCursor, 0, Math.max(0, phases.length - 1));
  const phase = phases[phaseCursor];
  const workflowActive = item.status === "running";
  // The filter narrows what the agent level walks, so the cursor and the card both
  // address the visible set rather than the phase's full roster.
  const agents = filterAgents({
    agents: phase?.agents ?? [],
    filter: state.agentFilter,
    workflowActive,
  });
  const agentCursor = clamp(state.agentCursor, 0, Math.max(0, agents.length - 1));
  const agent = agents[agentCursor];

  const footerHints = detailFooterHints({
    item,
    phases,
    agent,
    workflowActive,
    detailLevel: state.detailLevel,
    agentFilter: state.agentFilter,
  });
  // The frame is described before its body so the card can ask how many rows it may
  // occupy in this terminal, instead of windowing against a fixed guess.
  // No command echo and no panel title: the run's own name heads the body, and the
  // rows a footer would spend naming itself belong to the document instead.
  const frame: Omit<FooterPanelSpec, "body"> = {
    maxRows: input.terminalRows,
    fullscreen: true,
    footerHints,
  };

  const body = headerLines(item, phases, workflowActive);
  let cardScroll = state.cardScroll;
  const budget = Math.max(
    1,
    footerPanelBodyBudget({ ...frame, body }, input.terminalRows, input.width),
  );
  // The box takes every row the header leaves, so the frame reads the same height
  // whether a phase holds two agents or thirty.
  const paneRows = Math.max(1, budget - body.length);

  if (phases.length === 0) {
    body.push(renderTextWithStyles("No agents yet.", { color: Color.muted }));
  } else if (state.detailLevel === "agent" && agent && phase) {
    const split = canSplitDetail(contentWidth, AGENT_PANE_WIDTH);
    const card = agentCardLines({
      agent,
      workflowActive,
      contentWidth: split ? cardPaneWidth(contentWidth) : contentWidth,
      expanded: state.expandedPrompts.has(agent.label),
    });
    const windowed = windowCard(card, cardScroll, split ? paneRows - BOX_RULES : paneRows);
    cardScroll = windowed.scroll;
    const panes = split
      ? renderDetailPanes(
          {
            left: {
              title: phase.title,
              rows: agentPaneRows({
                agents,
                cursor: agentCursor,
                focused: true,
                workflowActive,
                withMeta: false,
              }),
            },
            right: { title: agent.label, rows: windowed.lines },
            leftWidth: AGENT_PANE_WIDTH,
          },
          contentWidth,
          paneRows,
        )
      : null;
    for (const line of panes ?? windowed.lines) body.push(line);
  } else {
    const inAgents = state.detailLevel === "agents";
    const panes = renderDetailPanes(
      {
        left: { title: "Phases", rows: phasePaneRows(phases, phaseCursor, !inAgents) },
        right: {
          title: phasePaneTitle(phase),
          rows: agentPaneRows({
            agents,
            cursor: agentCursor,
            focused: inAgents,
            workflowActive,
            withMeta: true,
          }),
        },
        leftWidth: PHASE_PANE_WIDTH,
      },
      contentWidth,
      paneRows,
    );
    if (panes) for (const line of panes) body.push(line);
    else if (inAgents && phase) {
      for (const line of phaseAgentLines({
        phase,
        agents,
        agentCursor,
        workflowActive,
        filterLabel: agentFilterLabel(state.agentFilter),
      })) {
        body.push(line);
      }
    } else {
      for (const line of phaseListLines(phases, phaseCursor, phase, contentWidth, workflowActive)) {
        body.push(line);
      }
    }
  }

  return {
    lines: renderFooterPanel({ ...frame, body }, input.width),
    phaseCursor,
    agentCursor,
    cardScroll,
  };
}

/**
 * Slide a card taller than its budget, keeping the marker that says rows are hidden.
 * The scroll is clamped here rather than by the key handler because only the render
 * knows how tall the card came out at this width.
 */
function windowCard(
  lines: readonly string[],
  scroll: number,
  budget: number,
): { lines: readonly string[]; scroll: number } {
  const height = Math.max(1, budget);
  if (lines.length <= height) return { lines, scroll: 0 };
  const visible = Math.max(1, height - 1);
  const clamped = clamp(scroll, 0, lines.length - visible);
  return {
    lines: [
      ...lines.slice(clamped, clamped + visible),
      listOverflowLine("down", lines.length - visible - clamped, undefined),
    ],
    scroll: clamped,
  };
}

function headerLines(
  item: WorkflowListItem,
  phases: MergedPhase[],
  workflowActive: boolean,
): string[] {
  const elapsedMs = workflowActive ? Math.max(0, Date.now() - item.startTime) : item.durationMs;
  const header = renderWorkflowHeader({
    name: item.name,
    description: item.description,
    status: item.status,
    counts: tallyWorkflowAgentCounts({ phases, declaredAgentCount: item.agentCount }),
    elapsedMs,
  });
  const lines = [renderTextWithStyles(header.name, { color: Color.panelAccent, bold: true })];
  if (header.subtext) lines.push(renderTextWithStyles(header.subtext, { color: Color.muted }));
  lines.push(renderTextWithStyles(header.stats, { color: Color.muted }));
  lines.push("");
  return lines;
}

function phaseListLines(
  phases: MergedPhase[],
  phaseCursor: number,
  phase: MergedPhase | undefined,
  contentWidth: number,
  workflowActive: boolean,
): string[] {
  const lines = [renderTextWithStyles("Phases", { bold: true, color: Color.text }), ""];
  for (let index = 0; index < phases.length; index++) {
    const row = phases[index]!;
    const selected = index === phaseCursor;
    const countsText = row.totalCount > 0 ? `${row.doneCount}/${row.totalCount}` : "";
    lines.push(
      renderPanelRowLine(
        {
          label: `${phaseGlyph(row.status, index)} ${row.title}`,
          selected,
          ...(countsText
            ? { value: countsText, valueColor: selected ? Color.panelAccent : Color.subtle }
            : {}),
        },
        contentWidth,
        DETAIL_ROW_WIDTH,
      ),
    );
  }
  if (phase && phase.agents.length > 0) {
    lines.push("");
    lines.push(
      renderTextWithStyles(`Agents in ${phase.title} · Enter to open`, { color: Color.muted }),
    );
    // The header names agents, so it shows them: a preview of the selected phase,
    // with the count that Enter reveals whenever the phase runs deeper than it.
    for (const agent of phase.agents.slice(0, PHASE_AGENT_PREVIEW_COUNT)) {
      lines.push(agentRowLine({ agent, selected: false, workflowActive }));
    }
    const beyondPreview = phase.agents.length - PHASE_AGENT_PREVIEW_COUNT;
    if (beyondPreview > 0) {
      lines.push(
        renderTextWithStyles(`  … ${beyondPreview} more ${pluralize(beyondPreview, "agent")}`, {
          color: Color.muted,
        }),
      );
    }
  }
  return lines;
}

function phaseAgentLines(input: {
  phase: MergedPhase;
  agents: readonly WorkflowAgentStatus[];
  agentCursor: number;
  workflowActive: boolean;
  filterLabel: string | undefined;
}): string[] {
  const { phase, agents, agentCursor, workflowActive, filterLabel } = input;
  // A narrowed list says what it is showing, so a short count never reads as a
  // phase that lost its agents.
  const count =
    filterLabel === undefined
      ? `${agents.length} ${pluralize(agents.length, "agent")}`
      : `showing ${agents.length} ${filterLabel}`;
  const lines = [
    renderTextWithStyles(`Phase · ${phase.title} (${count})`, { bold: true, color: Color.text }),
    "",
  ];
  if (agents.length === 0) {
    lines.push(
      renderTextWithStyles(
        filterLabel !== undefined
          ? `No ${filterLabel} agents in this phase`
          : phase.status === "not-started"
            ? "Not started yet"
            : "No agents",
        { color: Color.muted },
      ),
    );
    return lines;
  }
  for (let index = 0; index < agents.length; index++) {
    lines.push(
      agentRowLine({ agent: agents[index]!, selected: index === agentCursor, workflowActive }),
    );
  }
  return lines;
}

function agentRowLine(input: {
  agent: WorkflowAgentStatus;
  selected: boolean;
  workflowActive: boolean;
}): string {
  const { agent, selected, workflowActive } = input;
  const status = agentStatusLabel({ agent, workflowActive });
  const { glyph, color } = agentStatusGlyph(status);
  const meta = agentRowMeta(agent, status);
  return (
    renderTextWithStyles(selected ? Glyph.chevron : "  ", {
      color: selected ? Color.panelAccent : Color.muted,
    }) +
    renderTextWithStyles(glyph, {
      ...(color ? { color } : {}),
      dim: !selected && status === "running",
    }) +
    renderTextWithStyles(` ${agent.label}`, {
      color: selected ? Color.panelAccent : Color.text,
      bold: selected,
    }) +
    (meta
      ? renderTextWithStyles(` ${meta}`, { color: selected ? Color.panelAccent : Color.muted })
      : "")
  );
}

function agentCardLines(input: {
  agent: WorkflowAgentStatus;
  workflowActive: boolean;
  contentWidth: number;
  expanded: boolean;
}): string[] {
  const { agent, workflowActive, contentWidth, expanded } = input;
  const status = agentStatusLabel({ agent, workflowActive });
  const { glyph, color } = agentStatusGlyph(status);
  const lines: string[] = [];

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
  lines.push(
    renderTextWithStyles(`${glyph} ${AGENT_STATUS_LABELS[status]}`, {
      ...(color ? { color } : {}),
      bold: true,
    }) +
      (meta.length > 0
        ? renderTextWithStyles(`${META_SEPARATOR}${meta.join(META_SEPARATOR)}`, {
            color: Color.muted,
          })
        : ""),
  );

  const stats: string[] = [];
  if (agent.tokens != null) stats.push(`${formatTokens(agent.tokens)} tok`);
  if (agent.toolCalls != null && agent.toolCalls > 0) {
    stats.push(`${agent.toolCalls} ${pluralize(agent.toolCalls, "tool call")}`);
  }
  const now = Date.now();
  if (status === "done" && agent.startedAt !== undefined) {
    stats.push(formatDuration(agent.lastProgressAt - agent.startedAt));
  } else if (status === "running" && agent.startedAt !== undefined) {
    stats.push(formatDuration(Math.max(0, now - agent.startedAt)));
  } else if (status === "queued" && agent.queuedAt !== undefined) {
    stats.push(`waiting ${formatDuration(Math.max(0, now - agent.queuedAt))}`);
  }
  const idleSeconds = agentIdleSeconds(agent, status, now);
  if (idleSeconds !== null) stats.push(`idle ${formatDuration(idleSeconds * 1000)}`);
  if (stats.length > 0) {
    lines.push(renderTextWithStyles(stats.join(META_SEPARATOR), { color: Color.muted }));
  }
  lines.push("");

  for (const line of promptLines(agent, status, contentWidth, expanded)) lines.push(line);
  lines.push("");
  for (const line of activityLines(agent, status)) lines.push(line);
  lines.push("");
  for (const line of outcomeLines(agent, status, contentWidth)) lines.push(line);
  return lines;
}

function promptLines(
  agent: WorkflowAgentStatus,
  status: AgentDisplayStatus,
  contentWidth: number,
  expanded: boolean,
): string[] {
  const lines = [renderTextWithStyles("Prompt", { bold: true, color: Color.text })];
  const promptText = agent.transcript?.prompt ?? agent.promptPreview ?? "";
  if (promptText.length === 0) {
    lines.push(
      renderTextWithStyles(
        status === "running"
          ? "  Not available yet (agent still running)."
          : "  Transcript not available.",
        { color: Color.muted },
      ),
    );
    return lines;
  }
  const clipped =
    promptText.length > PROMPT_CLIP ? `${promptText.slice(0, PROMPT_CLIP - 1)}…` : promptText;
  const wrapped = wrapText(clipped, Math.max(8, contentWidth - 2));
  const visible = expanded ? wrapped : wrapped.slice(0, PROMPT_PREVIEW_MAX_LINES);
  for (const line of visible) {
    lines.push(renderTextWithStyles(`  ${line}`, { color: Color.muted }));
  }
  if (!expanded && wrapped.length > PROMPT_PREVIEW_MAX_LINES) {
    const hidden = wrapped.length - PROMPT_PREVIEW_MAX_LINES;
    lines.push(
      renderTextWithStyles(`  … ${hidden} more ${pluralize(hidden, "line")} · p expand`, {
        color: Color.muted,
      }),
    );
  }
  return lines;
}

function activityLines(agent: WorkflowAgentStatus, status: AgentDisplayStatus): string[] {
  const toolCalls = agent.transcript?.toolCalls ?? [];
  const lines = [
    renderTextWithStyles(
      toolCalls.length > ACTIVITY_TAIL_COUNT
        ? `Activity · last ${ACTIVITY_TAIL_COUNT} of ${toolCalls.length} tool calls`
        : "Activity",
      { bold: true, color: Color.text },
    ),
  ];
  if (toolCalls.length > 0) {
    for (const call of toolCalls.slice(-ACTIVITY_TAIL_COUNT)) {
      const summary = call.summary.length > 0 ? `(${call.summary})` : "";
      lines.push(renderTextWithStyles(`  ${call.name}${summary}`, { color: Color.muted }));
    }
  } else if (agent.lastToolName != null) {
    const summary =
      agent.lastToolSummary && agent.lastToolSummary.length > 0 ? `(${agent.lastToolSummary})` : "";
    lines.push(renderTextWithStyles(`  ${agent.lastToolName}${summary}`, { color: Color.muted }));
  } else {
    lines.push(
      renderTextWithStyles(status === "running" ? "  No tool calls yet." : "  No tool calls.", {
        color: Color.muted,
      }),
    );
  }
  return lines;
}

function outcomeLines(
  agent: WorkflowAgentStatus,
  status: AgentDisplayStatus,
  contentWidth: number,
): string[] {
  const lines = [renderTextWithStyles("Outcome", { bold: true, color: Color.text })];
  if (status === "running") {
    lines.push(renderTextWithStyles("  Still running…", { color: Color.muted }));
    return lines;
  }
  if (status === "interrupted") {
    lines.push(
      renderTextWithStyles("  The workflow stopped before this agent finished.", {
        color: Color.muted,
      }),
    );
    return lines;
  }
  if (status === "skipped") {
    lines.push(renderTextWithStyles("  Skipped at your request.", { color: Color.muted }));
    return lines;
  }
  if (status !== "failed" && status !== "done") return lines;

  const failed = status === "failed";
  const finalText = agent.transcript?.finalText;
  const detail = finalText ?? agent.resultPreview ?? "";
  if (detail.length === 0) {
    lines.push(
      failed
        ? renderTextWithStyles("  failed", { color: Color.error })
        : renderTextWithStyles("  (no captured output)", { color: Color.muted }),
    );
    return lines;
  }
  const clipped = detail.length > OUTCOME_CLIP ? `${detail.slice(0, OUTCOME_CLIP - 1)}…` : detail;
  const targetWidth = Math.max(8, contentWidth - 2);
  const wrapped =
    finalText !== undefined
      ? wrapProse(clipped, targetWidth)
      : wrapAnsi(clipped, targetWidth, {
          hard: true,
          trim: false,
          wordWrap: true,
        }).split("\n");
  for (const line of wrapped) {
    lines.push(renderTextWithStyles(`  ${line}`, { color: failed ? Color.error : Color.text }));
  }
  return lines;
}

export function detailFooterHints(input: {
  item: WorkflowListItem;
  phases: MergedPhase[];
  agent: WorkflowAgentStatus | undefined;
  workflowActive: boolean;
  detailLevel: DetailLevel;
  agentFilter: AgentFilter;
}): [string, string][] {
  const { item, phases, agent, workflowActive, detailLevel, agentFilter } = input;
  const hints: [string, string][] = [];
  const agentStatus = agent ? agentStatusLabel({ agent, workflowActive }) : undefined;
  // A queued agent has no fork to steer yet, so the control keys wait for it to start.
  const canControlAgent =
    workflowActive &&
    detailLevel === "agent" &&
    agent?.agentId !== undefined &&
    agentStatus === "running";
  const promptExpandable = detailLevel === "agent" && agent ? isPromptExpandable(agent) : false;
  const filterLabel = agentFilterLabel(agentFilter);

  if (detailLevel === "agent") {
    hints.push(["↑↓", "agent"]);
    hints.push(["j/k", "scroll"]);
    if (promptExpandable) hints.push(["p", "prompt"]);
    if (canControlAgent) {
      hints.push(["r", "restart"]);
      hints.push(["s", "skip"]);
    }
  } else if (phases.length > 0) {
    hints.push(["↑↓", "select"]);
    hints.push(["Enter", "open"]);
  }
  if (detailLevel === "agents" && phases.length > 0) {
    hints.push(["f", filterLabel === undefined ? "filter" : `filter: ${filterLabel}`]);
  }
  if (workflowActive && detailLevel === "phases") {
    hints.push(["x", "stop"]);
    hints.push(["p", "pause"]);
  } else if (workflowActive) {
    hints.push(["Space", "pause"]);
  }
  if (item.status === "paused" && item.scriptPath !== undefined) {
    hints.push(["Space", "resume"]);
  }
  hints.push(["←/Esc", "back"]);
  if (item.script.length > 0 && !canControlAgent) hints.push(["s", "save"]);
  return hints;
}
