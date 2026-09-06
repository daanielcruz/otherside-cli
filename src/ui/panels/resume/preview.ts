import { computeRowBudgetWindow, terminalRowBudget } from "@/kernel/std/list-window.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { hintChord, hintFor, type PanelHint } from "@/ui/chrome/panel-hints.ts";
import {
  type FooterPanelSpec,
  footerPanelBodyBudget,
  renderFooterPanel,
} from "@/ui/chrome/string-view-panel.ts";
import {
  clip,
  formatRelative,
  LABEL_CLIP_CHARS,
  type PreviewState,
} from "@/ui/panels/resume/entries.ts";
import { Color } from "@/ui/theme/theme.ts";

/** Preview rows the scroll window may spend, bounded like the list for the same reason. */
const PREVIEW_CAP = 20;
const PREVIEW_FLOOR = 4;

export const PREVIEW_HINTS: readonly PanelHint[] = [
  hintFor("enterResume"),
  hintFor("arrowsScroll"),
  hintFor("back"),
];

export interface ResumePreviewInput {
  preview: PreviewState;
  resumeError: string | null;
  /** Where the scroll sat before this paint; the render clamps it to the content. */
  scroll: number;
  /** The page size the last paint resolved; an empty preview leaves it untouched. */
  previousVisibleRows: number;
  terminalRows: number;
}

/** The window this paint settled on — the key layer pages by what was drawn. */
export interface ResumePreviewLayout {
  rows: string[];
  scroll: number;
  visiblePreviewRows: number;
}

export function renderResumePreview(input: ResumePreviewInput, width: number): ResumePreviewLayout {
  const { preview, terminalRows } = input;
  const spec: FooterPanelSpec = {
    command: "/resume",
    title: "Preview session",
    footerHints: PREVIEW_HINTS.map(hintPair),
    maxRows: terminalRows,
    body: [],
  };
  const body: string[] = [];
  let scroll = input.scroll;
  let visiblePreviewRows = input.previousVisibleRows;

  if (input.resumeError !== null) {
    body.push(renderTextWithStyles(input.resumeError, { color: Color.error }));
  }

  if (preview.loading) {
    body.push(renderTextWithStyles("Loading session…", { color: Color.muted }));
  } else if (preview.error !== undefined) {
    body.push(renderTextWithStyles(preview.error, { color: Color.error }));
  } else if (preview.lines.length === 0) {
    body.push(renderTextWithStyles(metaHeaderFor(preview), { color: Color.muted }));
    body.push(renderTextWithStyles("No messages to preview.", { color: Color.muted }));
  } else {
    body.push(renderTextWithStyles(metaHeaderFor(preview), { color: Color.muted }));
    const chromeAndShellRows = terminalRows - footerPanelBodyBudget(spec, terminalRows, width);
    const budgetRows = terminalRowBudget({
      terminalRows,
      reservedRows: chromeAndShellRows + body.length,
      floorRows: PREVIEW_FLOOR,
      capRows: PREVIEW_CAP,
    });
    // Clamp the scroll so the last page stays full (one row goes to the marker).
    const maxStart =
      preview.lines.length > budgetRows ? preview.lines.length - (budgetRows - 1) : 0;
    scroll = Math.min(Math.max(0, scroll), maxStart);
    const window = computeRowBudgetWindow({
      cursor: scroll,
      itemRows: preview.lines.map(() => 1),
      budgetRows,
      previousStart: scroll,
    });
    visiblePreviewRows = Math.max(1, window.to - window.from);
    if (window.markerAbove !== undefined) {
      body.push(renderTextWithStyles(window.markerAbove, { color: Color.muted }));
    }
    for (const line of preview.lines.slice(window.from, window.to)) {
      const marker = line.role === "user" ? "❯ " : "  ";
      const markerColor = line.role === "user" ? Color.panelAccent : Color.muted;
      const textColor = line.role === "user" ? Color.text : Color.muted;
      body.push(
        renderTextWithStyles(marker, { color: markerColor }) +
          renderTextWithStyles(clip(line.text.replace(/\s+/g, " "), LABEL_CLIP_CHARS), {
            color: textColor,
          }),
      );
    }
    if (window.markerBelow !== undefined) {
      body.push(renderTextWithStyles(window.markerBelow, { color: Color.muted }));
    }
  }

  spec.body = body;
  return { rows: renderFooterPanel(spec, width), scroll, visiblePreviewRows };
}

/** The preview's one-line summary: how long ago the session ran, and how much of it there is. */
export function metaHeaderFor(preview: PreviewState): string {
  const count = preview.lines.length;
  return `${formatRelative(preview.updatedAt)} · ${count} message${count === 1 ? "" : "s"}`;
}

function hintPair(hint: PanelHint): [string, string] {
  return [hintChord(hint.keys), hint.label];
}
