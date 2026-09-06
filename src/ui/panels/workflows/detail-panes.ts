import type { MergedPhase } from "@/engine/background/workflows/runtime/progress/merge.ts";
import type { WorkflowAgentStatus } from "@/engine/background/workflows/runtime/store/types.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { agentStatusGlyph } from "@/ui/chrome/progress/glyphs.ts";
import { renderSplitPane, type SplitPaneColumn, splitPaneWidths } from "@/ui/chrome/split-pane.ts";
import { agentRowMeta, agentStatusLabel, phaseGlyph } from "@/ui/panels/workflows/items.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

/**
 * The detail's two columns. Phases stand beside the agents of whichever phase is
 * selected, so opening a phase never costs sight of the others; at the deepest
 * level the agent list stands beside the card of the agent selected in it.
 */

/** Cells the phase column keeps: a number, a title, and a done/total count. */
const PHASE_PANE_WIDTH = 22;
/** Cells the agent list keeps when it stands beside a card. */
const AGENT_PANE_WIDTH = 24;
/** Rules the box spends, top and bottom. */
const BOX_RULE_ROWS = 2;

export interface DetailPanes {
  left: { title: string; rows: readonly string[] };
  right: { title: string; rows: readonly string[] };
  /** Cells the left column takes; the right takes what the frame has left. */
  leftWidth: number;
}

/**
 * Draw both columns inside one frame-sized box, or report that the frame is too
 * narrow to hold them. A null answer is the caller's cue to stack instead — the
 * columns are never squeezed past the point where either stops being readable.
 */
export function renderDetailPanes(
  panes: DetailPanes,
  width: number,
  bodyRows: number,
): string[] | null {
  const widths = splitPaneWidths(width, panes.leftWidth);
  if (widths === null) return null;
  const column = (side: DetailPanes["left"], cells: number): SplitPaneColumn => ({
    title: side.title,
    rows: side.rows,
    width: cells,
  });
  return renderSplitPane({
    left: column(panes.left, widths.left),
    right: column(panes.right, widths.right),
    height: Math.max(1, bodyRows - BOX_RULE_ROWS),
  });
}

/**
 * Whether this frame can carry both columns. Asked before the content is built so
 * the card is windowed once, against the height the chosen layout actually leaves.
 */
export function canSplitDetail(width: number, leftWidth: number): boolean {
  return splitPaneWidths(width, leftWidth) !== null;
}

/** Cells the card wraps to once it shares the frame with the agent list. */
export function cardPaneWidth(width: number): number {
  return splitPaneWidths(width, AGENT_PANE_WIDTH)?.right ?? width;
}

/** Rows for the phase column: number or outcome glyph, title, and its tally. */
export function phasePaneRows(
  phases: readonly MergedPhase[],
  cursor: number,
  focused: boolean,
): string[] {
  return phases.map((phase, index) => {
    const selected = focused && index === cursor;
    const counts = phase.totalCount > 0 ? `${phase.doneCount}/${phase.totalCount}` : "";
    const head = renderTextWithStyles(selected ? Glyph.chevron : "  ", {
      color: selected ? Color.panelAccent : Color.muted,
    });
    const title = renderTextWithStyles(`${phaseGlyph(phase.status, index)} ${phase.title}`, {
      color: selected ? Color.panelAccent : Color.text,
      bold: selected,
    });
    const tally = counts
      ? renderTextWithStyles(` ${counts}`, {
          color: selected ? Color.panelAccent : Color.subtle,
        })
      : "";
    return head + title + tally;
  });
}

/** Rows for the agent column: outcome glyph in its own color, label, then meta. */
export function agentPaneRows(input: {
  agents: readonly WorkflowAgentStatus[];
  cursor: number;
  focused: boolean;
  workflowActive: boolean;
  withMeta: boolean;
}): string[] {
  const { agents, cursor, focused, workflowActive, withMeta } = input;
  return agents.map((agent, index) => {
    const selected = focused && index === cursor;
    const status = agentStatusLabel({ agent, workflowActive });
    const { glyph, color } = agentStatusGlyph(status);
    const meta = withMeta ? agentRowMeta(agent, status) : "";
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
  });
}

/** A phase named with the size of what it holds, for a column heading. */
export function phasePaneTitle(phase: MergedPhase | undefined): string {
  if (!phase) return "Agents";
  const count = phase.agents.length;
  return `${phase.title} · ${count} ${pluralize(count, "agent")}`;
}

export { AGENT_PANE_WIDTH, BOX_RULE_ROWS, PHASE_PANE_WIDTH };
