import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { hintFor, hintPair } from "@/ui/chrome/panel-hints.ts";
import { panelStatusColor, workflowPanelStatus } from "@/ui/chrome/progress/glyphs.ts";
import {
  type ListPanelSpec,
  listPanelPageSize,
  renderListPanel,
} from "@/ui/chrome/string-view-panel.ts";
import {
  rowMeta,
  statusGlyph,
  subtitleText,
  truncateName,
  type WorkflowListItem,
} from "@/ui/panels/workflows/items.ts";
import { Color } from "@/ui/theme/theme.ts";

const PANEL_COMMAND = "/workflows";

export interface WorkflowListInput {
  items: WorkflowListItem[];
  cursor: number;
  loading: boolean;
  terminalRows: number;
}

/** Keys the list offers depend on what the selected run can still be told to do. */
export function listFooterHints(
  items: readonly WorkflowListItem[],
  selected: WorkflowListItem | undefined,
): [string, string][] {
  if (items.length === 0) return [hintPair(hintFor("close"))];
  const hints = [hintFor("arrowsSelect"), hintFor("enterView")];
  // A running workflow yields to pause first; only an already-paused one is killed.
  if (selected?.status === "running") hints.push(hintFor("xPause"));
  else if (selected?.status === "paused") hints.push(hintFor("xKill"));
  if (selected !== undefined && selected.script.length > 0) hints.push(hintFor("sSave"));
  hints.push(hintFor("close"));
  return hints.map(hintPair);
}

/**
 * The status glyph carries the run's outcome in its own color, so a failed run reads
 * as failed at a glance while the name keeps the row's selection treatment. A running
 * workflow has no settled outcome and its spinner stays uncolored.
 */
function workflowRowLabel(
  item: WorkflowListItem,
  selected: boolean,
): { label: string; styledLabel: string } {
  const glyph = statusGlyph(item.status);
  const name = truncateName(item.name);
  const panelStatus = workflowPanelStatus(item.status);
  const glyphColor = panelStatus === undefined ? undefined : panelStatusColor(panelStatus);
  return {
    label: `${glyph} ${name}`,
    styledLabel:
      renderTextWithStyles(`${glyph} `, glyphColor === undefined ? {} : { color: glyphColor }) +
      renderTextWithStyles(name, {
        color: selected ? Color.panelAccent : Color.text,
        bold: selected,
      }),
  };
}

function workflowListSpec(input: WorkflowListInput): ListPanelSpec {
  const { items, cursor } = input;
  return {
    command: PANEL_COMMAND,
    title: "Dynamic workflows",
    items: items.map((item, index) => ({
      id: item.id,
      ...workflowRowLabel(item, index === cursor),
      value: rowMeta(item),
    })),
    cursor,
    maxRows: input.terminalRows,
    // An environment still reading history says so, rather than claiming emptiness it
    // has not established yet.
    // The list is scoped to this session, so the empty state says so rather than
    // implying the user has never run one.
    emptyLabel: input.loading
      ? "Loading dynamic workflow history…"
      : "No dynamic workflows in this session.",
    footerHints: listFooterHints(items, items[cursor]),
    ...(items.length === 0 ? {} : { subtitle: subtitleText(items) }),
  };
}

/** Rows the list shows at once, so the panel's page keys step by what it draws. */
export function workflowListPageSize(input: WorkflowListInput): number {
  return listPanelPageSize(workflowListSpec(input));
}

export function renderWorkflowList(input: WorkflowListInput & { width: number }): string[] {
  return renderListPanel(workflowListSpec(input), input.width);
}
