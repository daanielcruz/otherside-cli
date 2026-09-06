import { computeRowBudgetWindow, terminalRowBudget } from "@/kernel/std/list-window.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { hintLines, type PanelHint } from "@/ui/chrome/panel-hints.ts";
import {
  type FooterPanelSpec,
  footerPanelBodyBudget,
  renderFooterPanel,
} from "@/ui/chrome/string-view-panel.ts";
import type { ResumeMode } from "@/ui/panels/resume/controller.ts";
import {
  labelFor,
  metaTextFor,
  ROWS_PER_SESSION,
  type SessionEntry,
} from "@/ui/panels/resume/entries.ts";
import {
  basenameOfCwd,
  listHints,
  RENAME_HINTS,
  renderResumeRowLines,
  SEARCH_HINTS,
} from "@/ui/panels/resume/picker-view.ts";
import { Color } from "@/ui/theme/theme.ts";

/** Session rows the list window may spend — a compact cap so the transcript stays visible. */
const SESSION_LIST_CAP = 8 * ROWS_PER_SESSION;

export interface ResumeListInput {
  sessions: readonly SessionEntry[];
  branch: string | null;
  cursor: number;
  query: string;
  mode: ResumeMode;
  rename: { id: string; value: string } | null;
  showAllProjects: boolean;
  branchFilterEnabled: boolean;
  loading: boolean;
  resumeError: string | null;
  /** Where the window started last paint, so the anchor scroll stays stable. */
  previousStart: number;
  /** The page size the last paint resolved; an empty list leaves it untouched. */
  previousVisibleCount: number;
  terminalRows: number;
}

/** The window this paint settled on — the key layer pages by what was drawn. */
export interface ResumeListLayout {
  rows: string[];
  listStart: number;
  visibleSessionCount: number;
}

export function renderResumeList(input: ResumeListInput, width: number): ResumeListLayout {
  const { sessions, branch, cursor, terminalRows } = input;
  const refreshing = input.loading ? " · Refreshing…" : "";
  const counter = sessions.length > 0 ? ` (${cursor + 1} of ${sessions.length})` : "";
  const spec: FooterPanelSpec = {
    command: "/resume",
    title: `Resume session${counter}${refreshing}`,
    search: {
      query: input.query,
      placeholder: "Search…",
      focused: input.mode === "search",
    },
    searchMarginBottom: 0,
    maxRows: terminalRows,
    body: [],
  };
  if (input.resumeError !== null) spec.subtitle = input.resumeError;

  const body: string[] = [];
  const filterLabels = input.showAllProjects ? [] : [basenameOfCwd(process.cwd())];
  if (input.branchFilterEnabled && branch !== null) filterLabels.push(branch);
  const filters = filterLabels.filter((label): label is string => label !== null);
  if (filters.length > 0) {
    body.push("  " + renderTextWithStyles(filters.join(" · "), { color: Color.muted }));
  }
  body.push("");

  const hints =
    input.mode === "rename"
      ? RENAME_HINTS
      : input.mode === "search"
        ? SEARCH_HINTS
        : listHints(branch, input.branchFilterEnabled, input.showAllProjects, sessions.length > 0);
  // The blank separates the hints from the list's overflow marker; it rides in
  // hintRows so the window budget reserves it.
  const hintRows = ["", ...mutedHintLines(hints, width)];

  let listStart = input.previousStart;
  let visibleSessionCount = input.previousVisibleCount;

  if (sessions.length === 0) {
    const emptyLabel =
      input.query.length > 0
        ? `No sessions match "${input.query}".`
        : input.loading
          ? "Loading conversations…"
          : "No conversations found in this project.";
    body.push(renderTextWithStyles(emptyLabel, { color: Color.muted }));
  } else {
    // Rows the window may spend: the body budget of this frame, minus the body
    // rows already claimed above and by the hints, compact-capped.
    const chromeAndShellRows = terminalRows - footerPanelBodyBudget(spec, terminalRows, width);
    const window = computeRowBudgetWindow({
      cursor,
      itemRows: sessions.map(() => ROWS_PER_SESSION),
      budgetRows: terminalRowBudget({
        terminalRows,
        reservedRows: chromeAndShellRows + body.length + hintRows.length,
        floorRows: ROWS_PER_SESSION,
        capRows: SESSION_LIST_CAP,
      }),
      previousStart: input.previousStart,
    });
    listStart = window.from;
    visibleSessionCount = Math.max(1, window.to - window.from);
    if (window.markerAbove !== undefined) {
      body.push(renderTextWithStyles(window.markerAbove, { color: Color.muted }));
    }
    for (let index = window.from; index < window.to; index += 1) {
      const session = sessions[index]!;
      // The selection pointer belongs to the focused list; search owns focus.
      const selected = index === cursor && input.mode !== "search";
      const renaming =
        input.rename?.id === session.id && input.mode === "rename" ? input.rename.value : null;
      const baseLabel = labelFor(session);
      const label =
        renaming === null ? baseLabel : `${renaming.length > 0 ? renaming : baseLabel}▏`;
      const meta = metaTextFor(session);
      const project =
        input.showAllProjects && session.phase === "enriched" && session.cwd !== null
          ? ` · ${session.cwd}`
          : "";
      const row = {
        label,
        description: meta + project,
        selected,
        rows: ROWS_PER_SESSION,
        labelBold: false,
      };
      body.push(...renderResumeRowLines(row, width));
    }
    if (window.markerBelow !== undefined) {
      body.push(renderTextWithStyles(window.markerBelow, { color: Color.muted }));
    }
  }

  body.push(...hintRows);
  spec.body = body;
  return { rows: renderFooterPanel(spec, width), listStart, visibleSessionCount };
}

/** Hint lines wrapped to the panel content width, rendered muted for the body. */
function mutedHintLines(hints: readonly PanelHint[], width: number): string[] {
  return hintLines(hints, Math.max(1, width - 4)).map((line) =>
    renderTextWithStyles(line, { color: Color.muted }),
  );
}
