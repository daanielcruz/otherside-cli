import { ultracodeKeywordSpans } from "@/engine/queue/runtime/ultracode-directive.ts";
import { queueStore } from "@/store/queue-store/index.ts";
import { runningRef } from "@/store/turn-run/index.ts";
import type { CaretPosition } from "@/terminal-runtime/string-view/component.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import { openAgentAddressee } from "@/ui/input/agent-addressee.ts";
import type { PromptStyledRange } from "@/ui/input/prompt-chrome.ts";
import {
  caretInRows,
  promptContentRows,
  renderPromptHeader,
  renderPromptStroke,
  slashArgumentHint,
  standInRow,
  TOP_RULE_ROWS,
  validCommandTokenLength,
} from "@/ui/input/prompt-chrome.ts";
import type { PromptHistoryRun } from "@/ui/input/prompt-history-run.ts";
import { promptDisplayRows } from "@/ui/input/prompt-text.js";
import { QUEUED_EDIT_HINT, type QueuedEditHint } from "@/ui/input/queued-edit-hint.ts";
import type { VoiceHold } from "@/ui/input/voice-hold.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface PromptFrameInput {
  width: number;
  text: string;
  caret: number;
  bashMode: boolean;
  caretLit: boolean;
  searchOpen: boolean;
  queuedEditHint: QueuedEditHint;
  queuedEditHintShown: boolean;
  history: PromptHistoryRun;
  voice: VoiceHold;
  /** The modal selection to paint, or null when nothing is selected. */
  selection?: { start: number; end: number } | null;
  /** Whether writing the keyword opts the turn in, so the draft can say so. */
  keywordTrigger?: boolean;
  /** Whether the reader turned this draft's keyword off. */
  keywordDismissed?: boolean;
}

export interface PromptFrame {
  rows: string[];
  caret: CaretPosition | null;
  queuedEditHintShown: boolean;
}

export function promptFrame(input: PromptFrameInput): PromptFrame {
  const addressee = openAgentAddressee();
  const empty = !input.bashMode && input.text.length === 0;
  const showPlaceholder = empty && addressee !== null;
  const showQueuedEditHint =
    empty &&
    !showPlaceholder &&
    runningRef.current &&
    queueStore.getState().messages.length > 0 &&
    input.queuedEditHint.allowed;
  let queuedEditHintShown = input.queuedEditHintShown;
  if (showQueuedEditHint && !queuedEditHintShown) {
    queuedEditHintShown = true;
    input.queuedEditHint.markShown();
  }

  const preview = input.voice.preview();
  const displayText = preview?.text ?? input.text;
  const displayCaret = preview?.cursor ?? input.caret;
  const displayRows = promptDisplayRows(displayText, displayCaret, input.width);
  const standIn = showPlaceholder
    ? (addressee?.placeholder ?? "")
    : showQueuedEditHint
      ? QUEUED_EDIT_HINT
      : null;
  const content =
    standIn !== null
      ? [standInRow(standIn, input.caretLit)]
      : promptContentRows({
          rows: displayRows,
          bashMode: input.bashMode,
          commandTokenLength: validCommandTokenLength(displayText, input.bashMode),
          argHint:
            !input.searchOpen && !input.history.inRun()
              ? slashArgumentHint(displayText, input.bashMode)
              : null,
          caretLit: input.caretLit,
          styledRanges: styledRangesFor(input, preview, displayText),
          caretOverride: input.voice.meterCell(),
        });
  const caret =
    standIn !== null
      ? { row: TOP_RULE_ROWS, column: stringWidth(Glyph.promptChevron) }
      : caretInRows(displayRows, input.bashMode);
  const ruleColor = addressee === null ? Color.border : Color.primary;
  return {
    rows: [
      renderPromptHeader(
        input.width,
        readStringViewBrokerState(),
        input.history.position(),
        addressee?.identity ?? null,
        ruleColor,
      ),
      ...content,
      renderPromptStroke(input.width, ruleColor),
    ],
    caret,
    queuedEditHintShown,
  };
}

/**
 * Which span of the prompt text wears its own styles. Dictation dims the interim
 * text it is still revising; a modal selection paints inverse. Only one can be
 * true at a time — dictation replaces the whole draft, so there is no selection
 * to keep — and dictation wins because it owns the text on screen.
 */
function styledRangesFor(
  input: PromptFrameInput,
  preview: ReturnType<VoiceHold["preview"]>,
  displayText: string,
): PromptStyledRange[] {
  if (preview !== null && preview.cursor > preview.transcriptStart) {
    return [{ start: preview.transcriptStart, end: preview.cursor, styles: { dim: true } }];
  }
  const selection = input.selection ?? null;
  if (selection !== null && selection.end > selection.start) {
    return [{ start: selection.start, end: selection.end, styles: { inverse: true } }];
  }
  // Nothing is being dictated or selected, so the draft can say which words in
  // it will change what the turn does.
  return keywordRanges(displayText, input.keywordTrigger === true, input.keywordDismissed === true);
}

/**
 * The keyword lit wherever it opts the turn into orchestration — read by the
 * same function the turn uses, so what is lit and what opts in cannot disagree.
 */
function keywordRanges(
  text: string,
  triggerEnabled: boolean,
  dismissed: boolean,
): PromptStyledRange[] {
  if (!triggerEnabled) return [];
  // A dismissed keyword is struck rather than unpainted: the reader turned it
  // off and should see that it is off, not that it was never there.
  const styles = dismissed
    ? { color: Color.muted, strikethrough: true }
    : { color: Color.primary, bold: true };
  return ultracodeKeywordSpans(text).map((span) => ({
    start: span.start,
    end: span.end,
    styles,
  }));
}
