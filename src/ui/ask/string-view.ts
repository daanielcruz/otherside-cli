import {
  type GroupAnswer,
  type GroupQuestion,
  type PendingGroup,
  resolveGroup,
  subscribe,
} from "@/kernel/channels/ask.ts";
import { wrapIndex } from "@/kernel/std/math.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import type { StringFocusTarget } from "@/terminal-runtime/string-view/focus.js";
import { wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { fieldWithCaret } from "@/ui/chrome/field-caret.ts";
import { hintFor, hintPair } from "@/ui/chrome/panel-hints.ts";
import { renderFooterPanel } from "@/ui/chrome/string-view-panel.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { wrapOutputRows } from "@/ui/transcript/presentation.ts";

const REVIEW_TAB_LABEL = `${Glyph.check} Submit`;
/** Columns of padding a chip puts around its label, one on each side. */
const TAB_CHIP_PADDING = 2;
/** Columns a question chip spends beyond its header: the padding, the checkbox and its gap. */
const TAB_CHIP_CHROME = TAB_CHIP_PADDING + 2;
/** The narrowest a question chip is cut to while the active one keeps its room. */
const MIN_TAB_CHIP_WIDTH = 6;
const REVIEW_CHOICES = ["Submit answers", "Cancel"] as const;
/** Review rows set their text past the bullet the question hangs from. */
const REVIEW_ANSWER_INDENT = "   ";

interface QuestionState {
  cursor: number;
  marked: Set<number>;
  draft: string;
  draftCursor: number;
}

function freshQuestionState(): QuestionState {
  return { cursor: 0, marked: new Set(), draft: "", draftCursor: 0 };
}

export class StringViewAskPrompt implements StringComponent, StringFocusTarget {
  private context: StringViewContext | undefined;
  private unsubscribe: (() => void) | undefined;
  private group: PendingGroup | null = null;
  private activeTab = 0;
  private states: QuestionState[] = [];
  private answers = new Map<number, string>();
  private reviewCursor = 0;
  private focused = false;

  mount(context: StringViewContext): void {
    this.unmount();
    this.context = context;
    this.unsubscribe = subscribe((queue) => this.sync(queue[0] ?? null));
  }

  unmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.focused) this.context?.popFocus(this);
    this.focused = false;
    this.context = undefined;
    this.group = null;
  }

  render(width: number): string[] {
    if (!this.group) return [];
    const questions = this.group.questions;
    const question = questions[this.activeTab];
    const page = question
      ? [
          ...questionTitleLines(question.question, width),
          "",
          ...this.renderQuestion(question, width),
        ]
      : this.renderReview(questions, width);
    return renderFooterPanel(
      {
        body: [
          navigationBarLine({
            questions,
            activeTab: this.activeTab,
            answered: this.answers,
            width,
          }),
          "",
          ...page,
        ],
        flushTop: true,
        paddingX: 0,
        accent: Color.primaryGlow,
        footerItalic: false,
        ...(question ? { footerHints: questionHints(questions.length) } : {}),
      },
      width,
    );
  }

  handleKey(key: KeyEventData): void {
    if (!this.group) return;
    const questions = this.group.questions;
    const question = questions[this.activeTab];
    const state = this.states[this.activeTab];

    if (key.name === "escape") {
      this.resolve({ declined: true, reason: "cancel" });
      return;
    }
    // The free-text row keeps the step keys while it has focus: ←/→ move its caret
    // and Tab stays put, so typing an answer never throws the reader onto another step.
    const typing = question !== undefined && state?.cursor === freeformIndexOf(question);
    if (!typing && this.stepWith(key, questions)) return;
    if (!question) {
      this.handleReviewKey(key);
      return;
    }
    if (!state) return;

    const freeformIndex = freeformIndexOf(question);
    const chatIndex =
      question.allowChat === false ? -1 : question.options.length + (freeformIndex >= 0 ? 1 : 0);
    const rowCount =
      question.options.length + (freeformIndex >= 0 ? 1 : 0) + (chatIndex >= 0 ? 1 : 0);

    if (typing && this.editDraft(key, state)) return;
    if (key.name === "up") {
      state.cursor = (state.cursor - 1 + rowCount) % rowCount;
      this.repaint();
      return;
    }
    if (key.name === "down") {
      state.cursor = (state.cursor + 1) % rowCount;
      this.repaint();
      return;
    }
    if (question.multiSelect && key.sequence === " " && state.cursor < question.options.length) {
      this.toggleMarked(state, state.cursor);
      return;
    }
    const number = Number.parseInt(key.sequence ?? "", 10);
    if (Number.isInteger(number) && number >= 1 && number <= question.options.length) {
      if (question.multiSelect) this.toggleMarked(state, number - 1);
      else this.recordAnswer(question.options[number - 1]?.label ?? "");
      return;
    }
    if (key.name !== "return") return;
    if (state.cursor === chatIndex) {
      this.resolve({ declined: true, reason: "chat" });
      return;
    }
    if (state.cursor === freeformIndex) {
      const answer = state.draft.trim();
      if (answer.length > 0) this.recordAnswer(answer);
      return;
    }
    if (question.multiSelect) {
      const answer = question.options
        .filter((_, index) => state.marked.has(index))
        .map((option) => option.label)
        .join(", ");
      if (answer.length > 0) this.recordAnswer(answer);
      return;
    }
    this.recordAnswer(question.options[state.cursor]?.label ?? "");
  }

  private sync(group: PendingGroup | null): void {
    if (group?.id === this.group?.id) return;
    this.group = group;
    this.activeTab = 0;
    this.states = group?.questions.map(freshQuestionState) ?? [];
    this.answers = new Map();
    this.reviewCursor = 0;
    if (group && !this.focused) {
      this.context?.pushFocus(this);
      this.focused = true;
    } else if (!group && this.focused) {
      this.context?.popFocus(this);
      this.focused = false;
    }
    this.repaint();
  }

  /** Tab/→ step forward and Shift+Tab/← back, stopping at either end. */
  private stepWith(key: KeyEventData, questions: readonly GroupQuestion[]): boolean {
    const lastTab = hasReviewTab(questions) ? questions.length : questions.length - 1;
    if ((key.name === "tab" && !key.shift) || key.name === "right") {
      this.setTab(Math.min(this.activeTab + 1, lastTab));
      return true;
    }
    if ((key.name === "tab" && key.shift) || key.name === "left") {
      this.setTab(Math.max(this.activeTab - 1, 0));
      return true;
    }
    return false;
  }

  private setTab(tab: number): void {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    this.reviewCursor = 0;
    this.repaint();
  }

  private handleReviewKey(key: KeyEventData): void {
    if (key.name === "up" || key.name === "down") {
      const step = key.name === "up" ? -1 : 1;
      this.reviewCursor = wrapIndex(this.reviewCursor + step, REVIEW_CHOICES.length);
      this.repaint();
      return;
    }
    const choice =
      key.name === "return" ? this.reviewCursor : Number.parseInt(key.sequence ?? "", 10) - 1;
    if (REVIEW_CHOICES[choice] === "Submit answers") this.submitAll();
    if (REVIEW_CHOICES[choice] === "Cancel") this.resolve({ declined: true, reason: "cancel" });
  }

  private toggleMarked(state: QuestionState, index: number): void {
    if (state.marked.has(index)) state.marked.delete(index);
    else state.marked.add(index);
    this.repaint();
  }

  private editDraft(key: KeyEventData, state: QuestionState): boolean {
    if (key.name === "return") {
      const answer = state.draft.trim();
      if (answer.length > 0) this.recordAnswer(answer);
      return true;
    }
    if (key.name === "left") {
      state.draftCursor = Math.max(0, state.draftCursor - 1);
      this.repaint();
      return true;
    }
    if (key.name === "right") {
      state.draftCursor = Math.min(state.draft.length, state.draftCursor + 1);
      this.repaint();
      return true;
    }
    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      state.draftCursor = 0;
      this.repaint();
      return true;
    }
    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      state.draftCursor = state.draft.length;
      this.repaint();
      return true;
    }
    if (key.name === "backspace" || (key.ctrl && key.name === "h")) {
      if (state.draftCursor > 0) {
        state.draft =
          state.draft.slice(0, state.draftCursor - 1) + state.draft.slice(state.draftCursor);
        state.draftCursor -= 1;
      }
      this.repaint();
      return true;
    }
    if (key.name === "delete") {
      if (state.draftCursor < state.draft.length) {
        state.draft =
          state.draft.slice(0, state.draftCursor) + state.draft.slice(state.draftCursor + 1);
      }
      this.repaint();
      return true;
    }
    const input = key.sequence ?? "";
    if (key.ctrl || key.meta || input.length === 0 || /[\u0000-\u001f\u007f]/.test(input))
      return false;
    state.draft =
      state.draft.slice(0, state.draftCursor) + input + state.draft.slice(state.draftCursor);
    state.draftCursor += input.length;
    this.repaint();
    return true;
  }

  private recordAnswer(answer: string): void {
    if (!this.group || answer.length === 0) return;
    this.answers.set(this.activeTab, answer);
    const questions = this.group.questions;
    if (!hasReviewTab(questions)) {
      this.submitAll();
      return;
    }
    const next = questions.findIndex((_, index) => !this.answers.has(index));
    this.setTab(next === -1 ? questions.length : next);
  }

  private submitAll(): void {
    if (!this.group) return;
    const answers: GroupAnswer[] = [];
    this.group.questions.forEach((question, index) => {
      const answer = this.answers.get(index);
      if (answer) answers.push({ question: question.question, answer });
    });
    this.resolve({ declined: false, answers });
  }

  private resolve(result: Parameters<typeof resolveGroup>[1]): void {
    if (!this.group) return;
    resolveGroup(this.group.id, result);
  }

  private renderQuestion(question: GroupQuestion, width: number): string[] {
    const state = this.states[this.activeTab] ?? freshQuestionState();
    const freeformIndex = freeformIndexOf(question);
    const chatIndex =
      question.allowChat === false ? -1 : question.options.length + (freeformIndex >= 0 ? 1 : 0);
    const rows: string[] = [];
    question.options.forEach((option, index) => {
      const selected = state.cursor === index;
      const checked = question.multiSelect && state.marked.has(index);
      const prefix = `${selected ? Glyph.chevron : "  "}${question.multiSelect ? `[${checked ? "x" : " "}] ` : ""}${index + 1}. `;
      rows.push(optionRow(prefix, option.label, selected, checked ? Color.success : undefined));
      if (option.description.length > 0) {
        rows.push("     " + renderTextWithStyles(option.description, { color: Color.muted }));
      }
    });
    if (freeformIndex >= 0) {
      const focused = state.cursor === freeformIndex;
      const placeholder = question.multiSelect ? "Type something" : "Type something.";
      rows.push(
        ...customAnswerRows({
          index: freeformIndex + 1,
          draft: state.draft,
          cursor: state.draftCursor,
          placeholder,
          focused,
          width,
        }),
      );
    }
    if (chatIndex >= 0) {
      rows.push(renderTextWithStyles(Glyph.boxHLine.repeat(width), { color: Color.muted }));
      const focused = state.cursor === chatIndex;
      rows.push(
        renderTextWithStyles(`${focused ? Glyph.chevron : "  "}${chatIndex + 1}. Chat about this`, {
          color: focused ? Color.primaryGlow : Color.muted,
        }),
      );
    }
    const preview = question.options[state.cursor]?.preview;
    if (preview) {
      rows.push("");
      rows.push(
        ...wrapOutputRows(
          renderTextWithStyles(preview, { color: Color.muted }),
          Math.max(1, width - 4),
        ).map((line) => `  ${line}`),
      );
    }
    return rows;
  }

  private renderReview(questions: readonly GroupQuestion[], width: number): string[] {
    const rows = [
      renderTextWithStyles("Review your answers", { color: Color.text, bold: true }),
      "",
    ];
    if (questions.some((_, index) => !this.answers.has(index))) {
      rows.push(
        renderTextWithStyles(`${Glyph.warning} You have not answered all questions`, {
          color: Color.warning,
        }),
        "",
      );
    }
    const answered = questions.flatMap((question, index) => {
      const answer = this.answers.get(index);
      return answer === undefined ? [] : reviewAnswerRows(question.question, answer, width);
    });
    if (answered.length > 0) rows.push(...answered, "");
    rows.push(renderTextWithStyles("Ready to submit your answers?", { color: Color.muted }), "");
    REVIEW_CHOICES.forEach((label, index) => {
      const selected = index === this.reviewCursor;
      rows.push(optionRow(`${selected ? Glyph.chevron : "  "}${index + 1}. `, label, selected));
    });
    return rows;
  }

  private repaint(): void {
    this.context?.requestRender();
  }
}

/** Row of the free-text answer under the options, or -1 when the question takes none. */
function freeformIndexOf(question: GroupQuestion): number {
  return question.allowFreeform === false ? -1 : question.options.length;
}

/** A lone single-choice question submits on its answer; anything else ends on a review step. */
function hasReviewTab(questions: readonly GroupQuestion[]): boolean {
  return questions.length > 1 || questions.some((question) => question.multiSelect);
}

function questionHints(questionCount: number): [string, string][] {
  return [
    hintPair(hintFor("enterSelect")),
    hintPair(hintFor(questionCount === 1 ? "arrowsNavigate" : "tabsNavigate")),
    hintPair(hintFor("cancel")),
  ];
}

/**
 * The step row: `← ` and ` →` bracket one chip per question plus the review chip,
 * each padded a space per side and set flush against its neighbour. An arrow dims
 * at the end it cannot move past; a lone question without a review step shows its
 * chip alone.
 */
function navigationBarLine(options: {
  questions: readonly GroupQuestion[];
  activeTab: number;
  answered: ReadonlyMap<number, string>;
  width: number;
}): string {
  const { questions, activeTab, answered, width } = options;
  const review = hasReviewTab(questions);
  const reviewTab = questions.length;
  const labels = fittedTabLabels(
    questions.map((question, index) => question.header ?? `Q${index + 1}`),
    activeTab,
    width - (review ? TAB_CHIP_PADDING + stringWidth(REVIEW_TAB_LABEL) : 0),
  );
  const chips = labels.map((label, index) => {
    const box = answered.has(index) ? Glyph.ballotBoxX : Glyph.ballotBox;
    return tabChip(`${box} ${label}`, index === activeTab);
  });
  if (!review) return chips.join("");
  return (
    stepArrow(`${Glyph.arrowLeft} `, activeTab === 0) +
    chips.join("") +
    tabChip(REVIEW_TAB_LABEL, activeTab === reviewTab) +
    stepArrow(` ${Glyph.arrowRight}`, activeTab === reviewTab)
  );
}

function stepArrow(arrow: string, atEnd: boolean): string {
  return atEnd ? renderTextWithStyles(arrow, { color: Color.muted }) : arrow;
}

/**
 * Question headers cut to share the row with the arrows and the review chip. While
 * every header fits it is shown whole; past that the active one keeps up to half the
 * room and the rest split what remains.
 */
function fittedTabLabels(headers: readonly string[], activeTab: number, room: number): string[] {
  const available = room - stringWidth(`${Glyph.arrowLeft}  ${Glyph.arrowRight}`);
  const chipWidth = (header: string) => TAB_CHIP_CHROME + stringWidth(header);
  if (headers.reduce((total, header) => total + chipWidth(header), 0) <= available) {
    return [...headers];
  }
  const activeWidth = Math.min(chipWidth(headers[activeTab] ?? ""), available / 2);
  const otherWidth = Math.max(
    MIN_TAB_CHIP_WIDTH,
    Math.floor((available - activeWidth) / Math.max(headers.length - 1, 1)),
  );
  return headers.map((header, index) =>
    truncateEllipsis(
      header,
      Math.max(1, Math.floor(index === activeTab ? activeWidth : otherWidth) - TAB_CHIP_CHROME),
    ),
  );
}

function tabChip(label: string, active: boolean): string {
  const padded = ` ${label} `;
  if (!active) return padded;
  return renderTextWithStyles(padded, {
    backgroundColor: Color.panelAccent,
    color: Color.tabSelectedText,
  });
}

function reviewAnswerRows(question: string, answer: string, width: number): string[] {
  const bodyWidth = Math.max(1, width - REVIEW_ANSWER_INDENT.length);
  const questionRows = wrapProse(question, bodyWidth).map(
    (line, index) => (index === 0 ? ` ${Glyph.bulletFilled} ` : REVIEW_ANSWER_INDENT) + line,
  );
  const answerRows = wrapProse(`${Glyph.arrowRight} ${answer}`, bodyWidth).map(
    (line) => REVIEW_ANSWER_INDENT + renderTextWithStyles(line, { color: Color.success }),
  );
  return [...questionRows, ...answerRows];
}

function optionRow(
  prefix: string,
  label: string,
  selected: boolean,
  labelColor = selected ? Color.primaryGlow : Color.text,
): string {
  return (
    renderTextWithStyles(prefix, { color: selected ? Color.primaryGlow : Color.muted }) +
    renderTextWithStyles(label, { color: labelColor, bold: selected })
  );
}

function questionTitleLines(question: string, width: number): string[] {
  return wrapProse(question, width).map((line) =>
    renderTextWithStyles(line, { color: Color.text, bold: true }),
  );
}

function customAnswerRows(options: {
  index: number;
  draft: string;
  cursor: number;
  placeholder: string;
  focused: boolean;
  width: number;
}): string[] {
  const prefix = `${options.focused ? Glyph.chevron : "  "}${options.index}. `;
  const inputWidth = Math.max(1, options.width - stringWidth(prefix));
  const input = options.focused
    ? fieldWithCaret(options.draft, options.cursor, options.placeholder)
    : renderTextWithStyles(options.draft || options.placeholder, {
        color: options.draft ? Color.text : Color.muted,
      });
  const [first = "", ...rest] = wrapProse(input, inputWidth);
  const styledPrefix = renderTextWithStyles(prefix, {
    color: options.focused ? Color.primaryGlow : Color.muted,
  });
  const indent = " ".repeat(stringWidth(prefix));
  return [styledPrefix + first, ...rest.map((line) => indent + line)];
}
