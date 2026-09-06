import type { RewindToTranscriptIdFn } from "@/engine/session/rewind.ts";
import { computeRowBudgetWindow, terminalRowBudget } from "@/kernel/std/list-window.ts";
import { fileRestoreDiffStatsForTurn } from "@/kernel/storage/file-history.ts";
import { getTranscriptEntries, transcriptStore } from "@/store/transcript/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { wrapText } from "@/terminal-runtime/text/plain-wrap.ts";
import { keyInput } from "@/ui/chrome/key-input.ts";
import { hintFor, hintLines, type PanelHint } from "@/ui/chrome/panel-hints.ts";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import {
  FALLBACK_TERMINAL_ROWS,
  type FooterPanelSpec,
  footerPanelBodyBudget,
  renderFooterPanel,
} from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { renderRewindOptionLines } from "./option-rows.ts";
import {
  clampRewindIndex,
  formatRelativeTimeSince,
  numericConfirmationIndex,
  pageRewindIndex,
  type RestoreOption,
  type RewindOption,
  type RewindTurn,
  type RewindUserTurn,
  restoreOptionsFor,
  rewindTurns,
  userTurnsFromTranscript,
} from "./options.ts";

/** Rows one checkpoint option occupies; the floor keeps one option visible. */
const OPTION_LIST_FLOOR = 3;
/** Option rows the list window may spend — a compact cap so the transcript stays visible. */
const OPTION_LIST_CAP = 8 * OPTION_LIST_FLOOR;

/** Opener payload for selecting and restoring a rewind checkpoint. */
export interface RewindPanelProps {
  sessionId?: string;
  userTurns?: RewindUserTurn[];
  onRewind?: RewindToTranscriptIdFn;
}

const LIST_HINTS: readonly PanelHint[] = [hintFor("enterContinue"), hintFor("cancel")];
const EMPTY_HINTS: readonly PanelHint[] = [hintFor("cancel")];

/**
 * Conversation/code rewind checkpoint picker on the string model. Lists user turns
 * (from props or the transcript store) plus a "(current)" sentinel; Enter opens a
 * restore-mode confirm, which runs `onRewind` when that callback is provided via props.
 */
class RewindPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private unsub: (() => void) | undefined;

  private readonly sessionId: string;
  private readonly propTurns: RewindUserTurn[] | null;
  private readonly onRewind: RewindToTranscriptIdFn | undefined;

  private cursor = 0;
  private confirmTurn: RewindTurn | null = null;
  private restoreIdx = 0;
  private rewindError: string | null = null;

  /** Anchor-scroll state and the page size the last render produced. */
  private listStart = 0;
  private visibleOptionCount = 1;

  constructor(
    private readonly close: () => void,
    props?: RewindPanelProps,
  ) {
    this.sessionId = props?.sessionId ?? "";
    this.propTurns = props?.userTurns ?? null;
    this.onRewind = props?.onRewind;
    this.cursor = Math.max(0, this.options().length - 1);
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    if (this.propTurns === null) {
      this.unsub = transcriptStore.subscribe(() => {
        this.clampCursor();
        this.ctx?.requestRender();
      });
    }
    this.clampCursor();
    ctx.requestRender();
  }

  unmount(): void {
    this.unsub?.();
    this.unsub = undefined;
    this.ctx = undefined;
  }

  render(width: number): string[] {
    if (this.confirmTurn) return this.renderConfirm(width);
    return this.renderList(width);
  }

  handleKey(key: KeyEventData): void {
    const turns = this.turns();
    const hasMessages = turns.length > 0;

    if (panelKey(key) === "close") {
      if (this.confirmTurn) {
        this.confirmTurn = null;
        this.rewindError = null;
        this.ctx?.requestRender();
        return;
      }
      this.close();
      return;
    }

    if (!hasMessages) return;

    if (this.confirmTurn) {
      this.handleConfirmKey(key, this.confirmTurn);
      return;
    }
    this.handleListKey(key);
  }

  private handleListKey(key: KeyEventData): void {
    const options = this.options();
    const lastIndex = Math.max(0, options.length - 1);
    const visibleRows = Math.max(1, this.visibleOptionCount);
    const input = keyInput(key);

    if (key.shift && (input === "k" || input === "K")) {
      this.moveTo(0);
      return;
    }
    if (key.shift && (input === "j" || input === "J")) {
      this.moveTo(lastIndex);
      return;
    }
    if ((key.ctrl || key.meta || key.shift) && key.name === "up") {
      this.moveTo(0);
      return;
    }
    if ((key.ctrl || key.meta || key.shift) && key.name === "down") {
      this.moveTo(lastIndex);
      return;
    }
    if (key.name === "pageup") {
      this.moveTo(pageRewindIndex(this.cursor, options.length, -1, visibleRows));
      return;
    }
    if (key.name === "pagedown") {
      this.moveTo(pageRewindIndex(this.cursor, options.length, 1, visibleRows));
      return;
    }
    if (key.name === "up" || input === "k" || (key.ctrl && input === "p")) {
      this.moveTo(this.cursor - 1);
      return;
    }
    if (key.name === "down" || input === "j" || (key.ctrl && input === "n")) {
      this.moveTo(this.cursor + 1);
      return;
    }
    if (panelKey(key) === "confirm") {
      const option = options[this.cursor];
      if (!option || option.kind === "current") {
        this.close();
        return;
      }
      const defaults = restoreOptionsFor(option.filesChanged);
      const defaultIdx = defaults.findIndex(
        (entry) => entry.mode === (option.filesChanged > 0 ? "both" : "conversation"),
      );
      this.confirmTurn = option;
      this.restoreIdx = defaultIdx >= 0 ? defaultIdx : 0;
      this.rewindError = null;
      this.ctx?.requestRender();
    }
  }

  private handleConfirmKey(key: KeyEventData, turn: RewindTurn): void {
    const restoreOptions = restoreOptionsFor(turn.filesChanged);
    const input = keyInput(key);
    const numericIndex = numericConfirmationIndex(input, restoreOptions.length);
    if (numericIndex !== null) {
      this.activateRestore(turn, restoreOptions[numericIndex]!);
      return;
    }
    if (key.name === "up" || input === "k") {
      this.restoreIdx = Math.max(0, this.restoreIdx - 1);
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "down" || input === "j") {
      this.restoreIdx = Math.min(Math.max(0, restoreOptions.length - 1), this.restoreIdx + 1);
      this.ctx?.requestRender();
      return;
    }
    if (panelKey(key) === "confirm") {
      const option = restoreOptions[this.restoreIdx];
      if (option) this.activateRestore(turn, option);
    }
  }

  private activateRestore(turn: RewindTurn, option: { mode: RestoreOption; label: string }): void {
    if (option.mode === "nevermind") {
      this.confirmTurn = null;
      this.rewindError = null;
      this.ctx?.requestRender();
      return;
    }
    if (!this.onRewind) {
      this.rewindError =
        "Rewind action is not wired — pass onRewind via overlay props (createRewindToTranscriptId from session-ops).";
      this.ctx?.requestRender();
      return;
    }
    this.rewindError = null;
    // Handler owns overlay close (createRewindToTranscriptId calls closeTop).
    this.onRewind(turn.id, option.mode);
  }

  private moveTo(next: number): void {
    this.cursor = clampRewindIndex(next, this.options().length);
    this.ctx?.requestRender();
  }

  private clampCursor(): void {
    this.cursor = clampRewindIndex(this.cursor, this.options().length);
  }

  private sourceTurns(): RewindUserTurn[] {
    if (this.propTurns !== null) return this.propTurns;
    return userTurnsFromTranscript(getTranscriptEntries());
  }

  private turns(): RewindTurn[] {
    return rewindTurns(this.sourceTurns(), this.sessionId);
  }

  private options(): RewindOption[] {
    return [...this.turns(), { kind: "current", id: "__current" }];
  }

  private terminalRows(): number {
    return this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
  }

  private renderList(width: number): string[] {
    const terminalRows = this.terminalRows();
    const turns = this.turns();
    if (turns.length === 0) {
      const body = [
        renderTextWithStyles(this.rewindError ?? "Nothing to rewind to yet.", {
          color: this.rewindError ? Color.error : Color.text,
        }),
        "",
        ...mutedHintLines(EMPTY_HINTS, width),
      ];
      return renderFooterPanel({ title: "Rewind", maxRows: terminalRows, body }, width);
    }

    const options = this.options();
    const spec: FooterPanelSpec = {
      title: "Rewind",
      subtitle: "Restore the code and/or conversation to the point before…",
      maxRows: terminalRows,
      body: [],
    };
    const body: string[] = [];
    if (this.rewindError !== null) {
      body.push(renderTextWithStyles(this.rewindError, { color: Color.error }), "");
    }
    const hintRows = mutedHintLines(LIST_HINTS, width);
    const optionLines = options.map((option, index) =>
      renderRewindOptionLines(option, index === this.cursor, width),
    );
    // Rows the window may spend: the body budget of this frame, minus the body
    // rows already claimed above and by the hints, compact-capped.
    const chromeAndShellRows = terminalRows - footerPanelBodyBudget(spec, terminalRows, width);
    const window = computeRowBudgetWindow({
      cursor: this.cursor,
      itemRows: optionLines.map((lines) => lines.length),
      budgetRows: terminalRowBudget({
        terminalRows,
        reservedRows: chromeAndShellRows + body.length + 1 + hintRows.length,
        floorRows: OPTION_LIST_FLOOR,
        capRows: OPTION_LIST_CAP,
      }),
      previousStart: this.listStart,
    });
    this.listStart = window.from;
    this.visibleOptionCount = Math.max(1, window.to - window.from);
    if (window.markerAbove !== undefined) {
      body.push(renderTextWithStyles(window.markerAbove, { color: Color.muted }));
    }
    for (let index = window.from; index < window.to; index += 1) {
      body.push(...optionLines[index]!);
    }
    if (window.markerBelow !== undefined) {
      body.push(renderTextWithStyles(window.markerBelow, { color: Color.muted }));
    }
    body.push("", ...hintRows);

    spec.body = body;
    return renderFooterPanel(spec, width);
  }

  private renderConfirm(width: number): string[] {
    const turn = this.confirmTurn!;
    const restoreOptions = restoreOptionsFor(turn.filesChanged);
    const selected = restoreOptions[this.restoreIdx]?.mode ?? "conversation";
    const restoresConversation = selected === "conversation" || selected === "both";
    const restoresCode = selected === "code" || selected === "both";
    const relative =
      turn.timestamp !== undefined ? formatRelativeTimeSince(new Date(turn.timestamp)) : null;
    const diffStats =
      restoresCode && turn.filesChanged > 0 && this.sessionId.length > 0
        ? fileRestoreDiffStatsForTurn(this.sessionId, turn.id)
        : null;
    const showDiffStat =
      diffStats !== null && (diffStats.insertions > 0 || diffStats.deletions > 0);

    const body: string[] = [];
    if (this.rewindError !== null) {
      body.push(renderTextWithStyles(this.rewindError, { color: Color.error }));
      body.push("");
    }
    for (const line of wrapText(
      "Confirm you want to restore to the point before you sent this message:",
      Math.max(1, width - 4),
    )) {
      body.push(renderTextWithStyles(line.trimEnd(), { color: Color.text }));
    }
    body.push("");
    for (const line of wrapText(turn.preview, Math.max(1, width - 8))) {
      body.push(
        renderTextWithStyles("│ ", { color: Color.muted }) +
          renderTextWithStyles(line.trimEnd(), { color: Color.text }),
      );
    }
    if (relative !== null) {
      body.push(
        renderTextWithStyles("│ ", { color: Color.muted }) +
          renderTextWithStyles(`(${relative})`, { color: Color.muted }),
      );
    }
    body.push("");
    body.push(
      renderTextWithStyles(
        restoresConversation
          ? "The conversation will be forked."
          : "The conversation will be unchanged.",
        { color: Color.muted },
      ),
    );

    if (restoresCode) {
      const filesLine = `${turn.filesChanged} file${turn.filesChanged === 1 ? "" : "s"} will be restored.`;
      if (showDiffStat && diffStats !== null) {
        body.push(
          renderTextWithStyles(filesLine + " ", { color: Color.muted }) +
            renderTextWithStyles(`+${diffStats.insertions}`, { color: Color.diffAddFg }) +
            " " +
            renderTextWithStyles(`-${diffStats.deletions}`, { color: Color.diffRemFg }),
        );
      } else {
        body.push(renderTextWithStyles(filesLine, { color: Color.muted }));
      }
    } else {
      body.push(renderTextWithStyles("The code will be unchanged.", { color: Color.muted }));
    }

    body.push("");
    restoreOptions.forEach((option, index) => {
      const isSelected = index === this.restoreIdx;
      const marker = renderTextWithStyles(isSelected ? Glyph.chevron : "  ", {
        color: isSelected ? Color.panelAccent : Color.muted,
      });
      const label = `${index + 1}. ${option.label}`;
      body.push(
        marker +
          renderTextWithStyles(label, {
            color: isSelected ? Color.panelAccent : Color.text,
          }),
      );
    });

    if (turn.filesChanged > 0) {
      body.push("");
      body.push(
        renderTextWithStyles("⚠ Rewinding does not affect files edited manually or via bash.", {
          color: Color.muted,
        }),
      );
    }

    return renderFooterPanel({ title: "Rewind", maxRows: this.terminalRows(), body }, width);
  }
}

/** Hint lines wrapped to the panel content width, rendered muted for the body. */
function mutedHintLines(hints: readonly PanelHint[], width: number): string[] {
  return hintLines(hints, Math.max(1, width - 4)).map((line) =>
    renderTextWithStyles(line, { color: Color.muted }),
  );
}

function narrowProps(props: unknown): RewindPanelProps | undefined {
  if (typeof props !== "object" || props === null) return undefined;
  const record = props as Record<string, unknown>;
  const out: RewindPanelProps = {};
  if (typeof record.sessionId === "string") out.sessionId = record.sessionId;
  if (Array.isArray(record.userTurns)) {
    const turns: RewindUserTurn[] = [];
    for (const raw of record.userTurns) {
      if (typeof raw !== "object" || raw === null) continue;
      const row = raw as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.text !== "string") continue;
      const turn: RewindUserTurn = { id: row.id, text: row.text };
      if (typeof row.ts === "string") turn.ts = row.ts;
      turns.push(turn);
    }
    out.userTurns = turns;
  }
  if (typeof record.onRewind === "function") {
    out.onRewind = record.onRewind as RewindToTranscriptIdFn;
  }
  return out;
}

export function createRewindPanel(close: () => void, props?: unknown): StringViewPanel {
  return new RewindPanel(close, narrowProps(props));
}
