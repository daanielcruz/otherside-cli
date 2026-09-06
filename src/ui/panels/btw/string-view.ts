import {
  type BtwTurn,
  type BtwTurnRetry,
  clearBtwTurns,
  listBtwTurns,
  subscribeBtwTurns,
} from "@/store/btw-store/index.ts";
import { recordPanelCommitRef } from "@/store/turn-run/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.ts";
import { cellClip } from "@/terminal-runtime/text/cell-clip.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { wrapText } from "@/terminal-runtime/text/plain-wrap.ts";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { spinnerFrame } from "@/ui/chrome/progress/index.ts";
import { FALLBACK_TERMINAL_ROWS } from "@/ui/chrome/string-view-panel.ts";
import { writeTextToClipboard } from "@/ui/input/paste/clipboard.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color } from "@/ui/theme/theme.ts";

/** Rows the surface spends above the response window (history renders on top of these). */
const HEADER_ROWS = 5;
/** Rows reserved beneath the response window (hints + breathing room). */
const FOOTER_ROWS = 6;
const MIN_RESPONSE_ROWS = 5;
const SCROLL_STEP = 3;
const VISIBLE_HISTORY_LIMIT = 5;
const SPINNER_TICK_MS = 80;
const CONTENT_PAD = "  ";
const RESPONSE_INDENT = "    ";

export interface BtwPanelProps {
  /** Spawns a fork carrying the answered turn; returns the transcript feedback line. */
  forkAnswer: (question: string, response: string) => string | null;
  /** Aborts the in-flight answer when the surface closes mid-question. */
  abortPending: () => void;
}

function summarize(text: string, maxWidth: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return stringWidth(flat) <= maxWidth ? flat : cellClip(flat, Math.max(1, maxWidth - 1)) + "…";
}

function retryLabel(retry: BtwTurnRetry): string {
  const reason = retry.reason.toLowerCase();
  if (reason.includes("rate")) return "Rate limited";
  if (reason.includes("overload") || reason.includes("quota")) return "API overloaded";
  if (reason.includes("auth") || reason.includes("401") || reason.includes("403")) {
    return "Authentication failed";
  }
  return "API error";
}

/**
 * The side-question surface: the answer streams into a scrollable window beneath
 * the question line while the main conversation keeps running untouched. Prior
 * answered questions stack above as dim one-liners (capped, with an elision
 * counter); `f` forks the conversation carrying the answered turn, `x` clears
 * the history keeping only a real answer, and any dismiss key closes — history
 * survives the close for the process lifetime.
 */
class BtwPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private unsubscribe: (() => void) | undefined;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private scrollOffset = 0;
  private forking = false;
  /** Offset back from the latest turn while ←/→ walks the history; 0 views the latest. */
  private viewBack = 0;

  constructor(
    private readonly close: () => void,
    private readonly props: BtwPanelProps | undefined,
  ) {}

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.unsubscribe = subscribeBtwTurns(() => {
      this.syncSpinner();
      this.ctx?.requestRender();
    });
    this.syncSpinner();
    ctx.requestRender();
  }

  unmount(): void {
    this.stopSpinner();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.ctx = undefined;
  }

  private currentTurn(): BtwTurn | undefined {
    return listBtwTurns().at(-1);
  }

  private viewedTurn(): BtwTurn | undefined {
    const turns = listBtwTurns();
    return turns[turns.length - 1 - this.viewBack];
  }

  private settled(turn: BtwTurn | undefined): boolean {
    return turn !== undefined && turn.status !== "pending";
  }

  private syncSpinner(): void {
    const pending = this.currentTurn()?.status === "pending";
    if (pending && this.spinnerTimer === undefined) {
      this.spinnerTimer = setInterval(() => this.ctx?.requestRender(), SPINNER_TICK_MS);
    } else if (!pending) {
      this.stopSpinner();
    }
  }

  private stopSpinner(): void {
    if (this.spinnerTimer !== undefined) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  private responseBudget(historyRows: number): number {
    const rows = this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
    return Math.max(MIN_RESPONSE_ROWS, rows - HEADER_ROWS - FOOTER_ROWS - historyRows);
  }

  handleKey(key: KeyEventData): void {
    if (this.forking) return;
    const current = this.currentTurn();
    const viewed = this.viewedTurn();
    // Nothing here to take or toggle, so every panel key but the level ones leaves.
    // The session-exit chords leave too: this overlay must never hold them.
    const panelAction = panelKey(key);
    const dismiss =
      panelAction === "close" ||
      panelAction === "confirm" ||
      panelAction === "toggle" ||
      (key.ctrl && (key.name === "c" || key.name === "d"));
    if (dismiss) {
      if (current?.status === "pending") this.props?.abortPending();
      this.close();
      return;
    }
    if (key.sequence === "x" && listBtwTurns().length > 0) {
      clearBtwTurns(current?.status === "answered" && !current.synthetic);
      this.viewBack = 0;
      this.scrollOffset = 0;
      this.ctx?.requestRender();
      return;
    }
    const answered = viewed?.status === "answered" && viewed.response !== null && !viewed.synthetic;
    if (key.sequence === "c" && answered && viewed.response !== null) {
      void writeTextToClipboard(viewed.response);
      return;
    }
    if (key.sequence === "f" && answered && viewed.response !== null) {
      const feedback = this.props?.forkAnswer(viewed.question, viewed.response);
      if (feedback !== null && feedback !== undefined) {
        this.forking = true;
        recordPanelCommitRef.current("btw", feedback);
        this.close();
      }
      return;
    }
    if (panelAction === "back" && this.viewBack < listBtwTurns().length - 1) {
      this.viewBack += 1;
      this.scrollOffset = 0;
      this.ctx?.requestRender();
      return;
    }
    if (panelAction === "forward" && this.viewBack > 0) {
      this.viewBack -= 1;
      this.scrollOffset = 0;
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - SCROLL_STEP);
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      this.scrollOffset += SCROLL_STEP;
      this.ctx?.requestRender();
    }
  }

  render(width: number): string[] {
    const turns = listBtwTurns();
    const turn = this.viewedTurn();
    if (turn === undefined) return [];
    const summaryWidth = Math.max(20, width - 7);
    const history = turns.filter((t) => t !== turn && t.status === "answered");
    const visibleHistory = history.slice(-VISIBLE_HISTORY_LIMIT);
    const elided = history.length - visibleHistory.length;

    const lines: string[] = [""];
    if (elided > 0) {
      lines.push(CONTENT_PAD + renderTextWithStyles(`(+${elided} earlier /btw)`, { dim: true }));
    }
    for (const entry of visibleHistory) {
      lines.push(
        CONTENT_PAD +
          renderTextWithStyles(`/btw ${summarize(entry.question, summaryWidth)}`, { dim: true }),
      );
    }
    lines.push(
      CONTENT_PAD +
        renderTextWithStyles("/btw ", { color: Color.warning, bold: true }) +
        renderTextWithStyles(summarize(turn.question, summaryWidth), { dim: true }),
    );
    lines.push("");

    const historyRows = visibleHistory.length + (elided > 0 ? 1 : 0);
    const budget = this.responseBudget(historyRows);
    for (const line of this.responseLines(turn, width, budget)) lines.push(line);

    lines.push("");
    lines.push(CONTENT_PAD + this.hintLine(turn));
    return lines.map((line) => cellClip(line, width));
  }

  private responseLines(turn: BtwTurn, width: number, budget: number): string[] {
    const contentWidth = Math.max(10, width - RESPONSE_INDENT.length - 2);
    if (turn.status === "error" || turn.status === "cancelled") {
      const message = turn.error ?? "(cancelled)";
      return wrapText(message, contentWidth)
        .slice(0, budget)
        .map((l) => RESPONSE_INDENT + renderTextWithStyles(l, { color: Color.error }));
    }
    if (turn.response !== null) {
      const wrapped = wrapText(turn.response, contentWidth);
      const maxOffset = Math.max(0, wrapped.length - budget);
      if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
      const view = wrapped.slice(this.scrollOffset, this.scrollOffset + budget);
      return view.map((l) => RESPONSE_INDENT + renderTextWithStyles(l, { color: Color.text }));
    }
    return [RESPONSE_INDENT + this.pendingLine(turn)];
  }

  private pendingLine(turn: BtwTurn): string {
    const now = Date.now();
    const spinner = renderTextWithStyles(spinnerFrame(now), { color: Color.warning });
    if (turn.retry === undefined) {
      return `${spinner} ${renderTextWithStyles("Answering…", { color: Color.warning })}`;
    }
    const seconds = Math.max(0, Math.ceil((turn.retry.retryAt - now) / 1000));
    return (
      `${spinner} ${renderTextWithStyles(retryLabel(turn.retry), { color: Color.warning })}` +
      renderTextWithStyles(
        ` · retrying in ${seconds}s · attempt ${turn.retry.attempt}/${turn.retry.maxAttempts}`,
        { dim: true },
      )
    );
  }

  private hintLine(turn: BtwTurn): string {
    if (this.forking) return renderTextWithStyles("Forking…", { dim: true });
    const several = listBtwTurns().length > 1;
    const hints: string[] = [];
    if (several) hints.push("←/→ to switch");
    else if (this.settled(turn)) hints.push("↑/↓ to scroll");
    if (turn.status === "answered" && turn.response !== null && !turn.synthetic) {
      hints.push("c to copy");
      hints.push("f to fork");
    }
    if (several) hints.push("x to clear history");
    hints.push("Esc to close");
    return renderTextWithStyles(hints.join(" · "), { dim: true });
  }
}

export function createBtwPanel(close: () => void, props?: BtwPanelProps): StringViewPanel {
  return new BtwPanel(close, props);
}
