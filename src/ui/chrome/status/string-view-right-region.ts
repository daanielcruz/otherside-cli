import { getActiveSessionId } from "@/engine/background/tasks/output-files.ts";
import { formatGoalStatusBar } from "@/engine/queue/runtime.ts";
import { getActiveGoal } from "@/engine/queue/state.ts";
import {
  type NoticeTone,
  type RightRegionSegment,
  selectRightRegionView,
} from "@/store/app-store/slices/right-region.ts";
import type { AppState } from "@/store/app-store/types.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import {
  BREATH_FRAME_MS,
  breathingGrey,
  PULSE_FRAME_MS,
  pulsedColor,
} from "@/ui/theme/color-pulse.ts";
import { Color, type ColorValue } from "@/ui/theme/theme.ts";

const SEPARATOR = " · ";
const SEPARATOR_WIDTH = stringWidth(SEPARATOR);

interface StyledPiece {
  readonly text: string;
  readonly tone: NoticeTone;
  readonly bold: boolean;
  readonly dim: boolean;
  /** Trailing hint rendered after the text in the same color, dimmed. */
  readonly dimSuffix?: string | null;
  /** When true, this piece may be dropped before others under a tight budget. */
  readonly dropFirst: boolean;
  /** Overrides the tone colour, for a piece whose colour carries motion of its own. */
  readonly color?: ColorValue;
}

function toneColor(tone: NoticeTone): ColorValue {
  if (tone === "error") return Color.error;
  if (tone === "warning") return Color.warning;
  if (tone === "success") return Color.success;
  if (tone === "primary") return Color.primaryGlow;
  if (tone === "design") return Color.designSession;
  return Color.muted;
}

function stylePiece(piece: StyledPiece): string {
  const color = piece.color ?? toneColor(piece.tone);
  const main = piece.bold
    ? renderTextWithStyles(piece.text, { color, bold: true })
    : piece.dim
      ? renderTextWithStyles(piece.text, { color, dim: true })
      : renderTextWithStyles(piece.text, { color });
  if (piece.dimSuffix === undefined || piece.dimSuffix === null || piece.dimSuffix.length === 0) {
    return main;
  }
  return main + renderTextWithStyles(piece.dimSuffix, { color, dim: true });
}

function limitText(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (stringWidth(text) <= budget) return text;
  if (budget <= 1) return "…";
  let end = text.length;
  while (end > 0 && stringWidth(text.slice(0, end)) + 1 > budget) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

/** Full on-screen width of a piece: its text plus the dim hint it trails. */
function pieceWidth(piece: StyledPiece): number {
  return stringWidth(piece.text) + stringWidth(piece.dimSuffix ?? "");
}

/**
 * Fit pieces into `maxWidth`, preferring to drop `dropFirst` pieces (token
 * suffix) before truncating earlier pieces (goal / notices / voice).
 */
function budgetPieces(pieces: readonly StyledPiece[], maxWidth: number): StyledPiece[] {
  if (pieces.length === 0 || maxWidth <= 0) return [];

  const ordered = [...pieces];
  // Drop optional trailing pieces until the remainder might fit.
  while (ordered.length > 0) {
    let needed = 0;
    for (let i = 0; i < ordered.length; i += 1) {
      needed += (i === 0 ? 0 : SEPARATOR_WIDTH) + pieceWidth(ordered[i]!);
    }
    if (needed <= maxWidth) break;
    const dropIdx = ordered
      .map((p, i) => (p.dropFirst ? i : -1))
      .filter((i) => i >= 0)
      .pop();
    if (dropIdx === undefined) break;
    ordered.splice(dropIdx, 1);
  }

  if (ordered.length === 0) return [];

  const result: StyledPiece[] = [];
  let remaining = maxWidth;
  for (let index = 0; index < ordered.length; index += 1) {
    const piece = ordered[index]!;
    const separatorCost = index === 0 ? 0 : SEPARATOR_WIDTH;
    if (remaining <= separatorCost) break;
    const textBudget = remaining - separatorCost;
    // The hint is kept whole or not at all: it yields the budget to the message.
    if (piece.dimSuffix != null && pieceWidth(piece) <= textBudget) {
      result.push(piece);
      remaining -= separatorCost + pieceWidth(piece);
      continue;
    }
    const text = limitText(piece.text, textBudget);
    if (text.length === 0) break;
    result.push({ ...piece, text, dimSuffix: null });
    remaining -= separatorCost + stringWidth(text);
  }
  return result;
}

function fromStoreSegments(
  segments: readonly RightRegionSegment[],
  now: number = Date.now(),
): StyledPiece[] {
  return segments.map((segment) => {
    const piece: StyledPiece = {
      text: segment.text,
      tone: segment.tone,
      bold: segment.bold,
      dim: segment.dim,
      dimSuffix: segment.dimSuffix,
      dropFirst: segment.key === "tokens",
    };
    // Processing has nothing to report yet, so its colour breathes to show it is alive.
    return segment.key === "voice-processing" ? { ...piece, color: breathingGrey(now) } : piece;
  });
}

function joinPieces(pieces: readonly StyledPiece[], maxWidth: number): string {
  const fitted = budgetPieces(pieces, maxWidth);
  if (fitted.length === 0) return "";
  return fitted.map(stylePiece).join(renderTextWithStyles(SEPARATOR, { color: Color.muted }));
}

function activeGoal(): ReturnType<typeof getActiveGoal> {
  const sessionId = getActiveSessionId();
  return sessionId === null ? undefined : getActiveGoal(sessionId);
}

/**
 * Right side of the model/context row: a transient warning takes it alone for as long
 * as it lives — quota, usage, voice — and when none is up the lasting readout and the
 * session token total have it. Exactly one row, so the chrome never grows a third.
 */
export function buildStatusLineRight(state: AppState, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  const now = Date.now();
  const view = selectRightRegionView(state.rightRegion, now, "statusline");
  if (view.ephemeral.length > 0) {
    return joinPieces(fromStoreSegments(view.ephemeral, now), maxWidth);
  }

  const pieces: StyledPiece[] = view.persistent.map((segment) => ({
    text: segment.text,
    tone: segment.tone,
    bold: segment.bold,
    dim: segment.dim,
    dimSuffix: segment.dimSuffix,
    dropFirst: segment.key === "tokens",
  }));
  return joinPieces(pieces, maxWidth);
}

/**
 * Right side of the mode row: the clipboard hint and the active goal share it, joined
 * by the separator only when both are up, followed by the session indicators that live
 * on this lane. The goal keeps its own pulsing colour and its live elapsed clock.
 */
export function buildStatusBarRight(state: AppState, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  const now = Date.now();
  const view = selectRightRegionView(state.rightRegion, now, "statusbar");
  const pieces: StyledPiece[] = fromStoreSegments(view.ephemeral, now);

  const goal = activeGoal();
  if (goal !== undefined) {
    pieces.push({
      text: formatGoalStatusBar(goal, now),
      tone: "primary",
      bold: false,
      dim: false,
      dropFirst: false,
      color: pulsedColor(toneColor("primary"), now - goal.setAt),
    });
  }

  pieces.push(...fromStoreSegments(view.persistent, now));
  return joinPieces(pieces, maxWidth);
}

/**
 * How often the model/context row must repaint itself, or null when it is static.
 * Voice processing has nothing to report yet, so its colour breathes.
 */
export function statusLineRefreshMs(state: AppState): number | null {
  return state.rightRegion.ephemeralCurrent?.key === "voice-processing" ? BREATH_FRAME_MS : null;
}

/** How often the mode row must repaint itself: only an active goal pulses. */
export function statusBarRefreshMs(): number | null {
  return activeGoal() === undefined ? null : PULSE_FRAME_MS;
}
