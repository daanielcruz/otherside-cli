import {
  type GroupAnswer,
  type GroupQuestion,
  type PendingGroup,
  resolveGroup,
  subscribe,
} from "@/kernel/channels/ask.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import type { StringFocusTarget } from "@/terminal-runtime/string-view/focus.js";
import { wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { renderFooterPanel } from "@/ui/chrome/string-view-panel.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { wrapOutputRows } from "@/ui/transcript/presentation.ts";

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
    const showSubmit = questions.length > 1 || questions.some((question) => question.multiSelect);
    const submitTab = showSubmit && this.activeTab === questions.length;
    const tabs =
      questions.length + (showSubmit ? 1 : 0) > 1
        ? [
            ...questions.map((question, index) => ({
              label: `${this.answers.has(index) ? Glyph.ballotBoxX : Glyph.ballotBox} ${question.header ?? `Q${index + 1}`}`,
            })),
            ...(showSubmit ? [{ label: `${Glyph.check} Submit` }] : []),
          ]
        : undefined;
    const question = submitTab ? undefined : questions[this.activeTab];
    const body = submitTab
      ? this.renderReview(questions, width)
      : question
        ? [
            ...questionTitleLines(question.question, Math.max(1, width - 4)),
            "",
            ...this.renderQuestion(question, width),
          ]
        : [];
    return renderFooterPanel(
      {
        ...(submitTab ? { title: "Review answers" } : {}),
        ...(tabs ? { tabs, activeTab: this.activeTab } : {}),
        body,
        accent: Color.primaryGlow,
        footerHints: submitTab
          ? [
              ["←/→", "tabs"],
              ["Enter", "submit"],
              ["Esc", "cancel"],
            ]
          : [
              ["Enter", "select"],
              [tabs ? "Tab/Arrows" : "↑/↓", "navigate"],
              ["Esc", "cancel"],
            ],
      },
      width,
    );
  }

  handleKey(key: KeyEventData): void {
    if (!this.group) return;
    const questions = this.group.questions;
    const showSubmit = questions.length > 1 || questions.some((question) => question.multiSelect);
    const tabCount = questions.length + (showSubmit ? 1 : 0);
    const submitTab = showSubmit && this.activeTab === questions.length;
    const question = submitTab ? undefined : questions[this.activeTab];
    const state = this.states[this.activeTab];

    if (key.name === "escape") {
      this.resolve({ declined: true, reason: "cancel" });
      return;
    }
    if ((key.name === "tab" && !key.shift) || key.name === "right") {
      this.setTab((this.activeTab + 1) % tabCount);
      return;
    }
    if ((key.name === "tab" && key.shift) || key.name === "left") {
      this.setTab((this.activeTab - 1 + tabCount) % tabCount);
      return;
    }
    if (submitTab) {
      if (key.name === "return") this.submitAll();
      return;
    }
    if (!question || !state) return;

    const freeformIndex = question.allowFreeform === false ? -1 : question.options.length;
    const chatIndex =
      question.allowChat === false ? -1 : question.options.length + (freeformIndex >= 0 ? 1 : 0);
    const rowCount =
      question.options.length + (freeformIndex >= 0 ? 1 : 0) + (chatIndex >= 0 ? 1 : 0);
    const typing = state.cursor === freeformIndex;

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
    if (group && !this.focused) {
      this.context?.pushFocus(this);
      this.focused = true;
    } else if (!group && this.focused) {
      this.context?.popFocus(this);
      this.focused = false;
    }
    this.repaint();
  }

  private setTab(tab: number): void {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    this.repaint();
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
    const showSubmit = questions.length > 1 || questions.some((question) => question.multiSelect);
    if (!showSubmit) {
      this.submitAll();
      return;
    }
    const next = questions.findIndex((_, index) => !this.answers.has(index));
    this.activeTab = next === -1 ? questions.length : next;
    this.repaint();
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
    const freeformIndex = question.allowFreeform === false ? -1 : question.options.length;
    const chatIndex =
      question.allowChat === false ? -1 : question.options.length + (freeformIndex >= 0 ? 1 : 0);
    const rows: string[] = [];
    question.options.forEach((option, index) => {
      const selected = state.cursor === index;
      const checked = question.multiSelect && state.marked.has(index);
      const prefix = `${selected ? Glyph.chevron : "  "}${question.multiSelect ? `[${checked ? "x" : " "}] ` : ""}${index + 1}. `;
      rows.push(
        renderTextWithStyles(prefix, { color: selected ? Color.primaryGlow : Color.muted }) +
          renderTextWithStyles(option.label, {
            color: checked ? Color.success : selected ? Color.primaryGlow : Color.text,
            bold: selected,
          }),
      );
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
          width: Math.max(1, width - 4),
        }),
      );
    }
    if (chatIndex >= 0) {
      rows.push(
        renderTextWithStyles(Glyph.boxHLine.repeat(Math.max(1, width - 4)), { color: Color.muted }),
      );
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
          Math.max(1, width - 8),
        ).map((line) => `  ${line}`),
      );
    }
    return rows;
  }

  private renderReview(questions: readonly GroupQuestion[], width: number): string[] {
    const rows: string[] = [];
    if (questions.some((_, index) => !this.answers.has(index))) {
      rows.push(
        renderTextWithStyles(`${Glyph.warning} You have not answered all questions`, {
          color: Color.warning,
        }),
      );
      rows.push("");
    }
    questions.forEach((question, index) => {
      rows.push(`${Glyph.bullet} ${question.question}`);
      rows.push(
        "  " +
          renderTextWithStyles(`→ ${this.answers.get(index) ?? "(unanswered)"}`, {
            color: this.answers.has(index) ? Color.success : Color.muted,
          }),
      );
      if (index < questions.length - 1) rows.push("");
    });
    return rows.flatMap((row) => wrapOutputRows(row, Math.max(1, width - 4)));
  }

  private repaint(): void {
    this.context?.requestRender();
  }
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
    ? draftWithCursor(options.draft, options.cursor, options.placeholder)
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

function draftWithCursor(draft: string, cursor: number, placeholder: string): string {
  if (draft.length === 0) {
    return (
      renderTextWithStyles(placeholder.slice(0, 1), { inverse: true }) +
      renderTextWithStyles(placeholder.slice(1), { color: Color.muted })
    );
  }
  const position = Math.max(0, Math.min(cursor, draft.length));
  const cursorCharacter = draft[position] ?? " ";
  return (
    renderTextWithStyles(draft.slice(0, position), { color: Color.text }) +
    renderTextWithStyles(cursorCharacter, { inverse: true }) +
    renderTextWithStyles(draft.slice(position + (position < draft.length ? 1 : 0)), {
      color: Color.text,
    })
  );
}
