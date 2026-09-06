import { userFacingToolName } from "@/engine/tools/tool-label.ts";
import {
  answer,
  type PendingPermission,
  PermissionResults,
  subscribe,
} from "@/kernel/channels/permission.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { typedText } from "@/ui/chrome/key-input.ts";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import {
  cycleStringViewPermissionMode,
  readStringViewBrokerState,
} from "@/ui/chrome/status/string-view-state.ts";
import {
  type FooterPanelSpec,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import { explanationLines } from "@/ui/panels/permission/explanation.ts";
import { armPermissionPromptNotification } from "@/ui/panels/permission/notification.ts";
import {
  bashRuleContentOf,
  buildGenericOptions,
  type PermissionOptionKind,
  type PermissionOptionRow,
  planOptionsFor,
  resultFor,
} from "@/ui/panels/permission/options.ts";
import {
  extractPlan,
  mcpDisplayFor,
  permissionTitle,
  styledProseLines,
  styledRawLines,
  toolPresentation,
  toolSignature,
} from "@/ui/panels/permission/tool-presentation.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { renderMarkdownLines } from "@/ui/transcript/markdown/string-view-markdown.ts";

const CONTENT_PAD_X = 2;
const PREFIX_PLACEHOLDER = "command prefix (e.g., npm run *)";
const PLAN_QUESTION =
  "Otherside has written up a plan and is ready to execute. Would you like to proceed?";

interface InputRowDisplay {
  label: string;
  styledLabel: string;
}

/** Footer surface for the head of the permission queue. */
export class StringViewPermissionPrompt implements StringComponent {
  private ctx: StringViewContext | undefined;
  private unsubscribe: (() => void) | undefined;
  private pending: PendingPermission | null = null;
  private cursor = 0;
  private amendMode = false;
  private amendDraft = "";
  private prefixDraft: string | null = null;
  private feedbackDraft = "";
  private explaining = false;
  private notification: ReturnType<typeof armPermissionPromptNotification> | null = null;
  private mountGeneration = 0;

  mount(ctx: StringViewContext): void {
    this.unmount();
    this.ctx = ctx;
    const generation = ++this.mountGeneration;
    this.unsubscribe = subscribe((queue) => this.updatePending(queue[0] ?? null));

    // A request may predate the root mount. Reassert its focus after sibling
    // components finish mounting so the permission surface still owns input.
    queueMicrotask(() => {
      if (generation !== this.mountGeneration || this.pending === null || this.ctx !== ctx) return;
      ctx.pushFocus(this);
      ctx.requestRender();
    });
  }

  unmount(): void {
    this.mountGeneration += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.notification?.cancel();
    this.notification = null;
    this.ctx?.popFocus(this);
    this.ctx = undefined;
    this.pending = null;
    this.resetDrafts();
  }

  render(width: number): string[] {
    const pending = this.pending;
    if (pending === null) return [];
    return pending.toolName === "ExitPlanMode"
      ? this.renderPlanPanel(pending, width)
      : this.renderGenericPanel(pending, width);
  }

  handleKey(key: KeyEventData): boolean {
    const pending = this.pending;
    if (pending === null) return false;
    this.notification?.markInteraction();

    const isPlan = pending.toolName === "ExitPlanMode";
    const options = this.optionsFor(pending);
    const selected = options[this.cursor];
    const planFeedbackFocused = isPlan && selected?.kind === "plan_feedback";
    const prefixFocused = this.isPrefixEditable(pending) && selected?.kind === "allow_always";

    const panelAction = panelKey(key);
    if (panelAction === "close" || panelAction === "back") {
      this.dismiss(pending, planFeedbackFocused);
      return true;
    }

    // The mode cycle belongs to the whole session, so it answers here too: the chat's
    // shift+tab cannot reach the keyboard while this surface holds it.
    if (key.shift && key.name === "tab") {
      cycleStringViewPermissionMode();
      this.ctx?.requestRender();
      return true;
    }

    if (key.ctrl && key.name === "e") {
      this.explaining = !this.explaining;
      this.ctx?.requestRender();
      return true;
    }

    if (key.name === "tab" && !isPlan && pending.source?.name !== "design") {
      if (selected?.kind === "allow" || selected?.kind === "deny" || this.amendMode) {
        this.amendMode = !this.amendMode;
        this.ctx?.requestRender();
      }
      return true;
    }

    if (key.name === "backspace" || key.name === "delete") {
      if (prefixFocused) {
        this.prefixDraft = this.prefixValue(pending).slice(0, -1);
        this.ctx?.requestRender();
        return true;
      }
      if (this.amendMode) {
        this.amendDraft = this.amendDraft.slice(0, -1);
        this.ctx?.requestRender();
        return true;
      }
      if (planFeedbackFocused) {
        this.feedbackDraft = this.feedbackDraft.slice(0, -1);
        this.ctx?.requestRender();
        return true;
      }
    }

    const input = typedText(key);
    if (prefixFocused && input.length > 0) {
      this.prefixDraft = this.prefixValue(pending) + input;
      this.ctx?.requestRender();
      return true;
    }
    if (this.amendMode && input.length > 0) {
      this.amendDraft += input;
      this.ctx?.requestRender();
      return true;
    }
    if (planFeedbackFocused && input.length > 0) {
      this.feedbackDraft += input;
      this.ctx?.requestRender();
      return true;
    }

    if (key.name === "up") {
      this.moveCursor(-1, options.length);
      return true;
    }
    if (key.name === "down") {
      this.moveCursor(1, options.length);
      return true;
    }
    if (panelAction === "confirm") {
      this.activate(pending, options, planFeedbackFocused);
      return true;
    }

    const direct = options.find((option) => option.key === input);
    if (direct !== undefined) {
      if (direct.kind === "plan_feedback") {
        this.cursor = Math.max(
          0,
          options.findIndex((option) => option.kind === "plan_feedback"),
        );
        this.ctx?.requestRender();
      } else {
        this.answerWith(pending, direct.kind);
      }
      return true;
    }

    return true;
  }

  private updatePending(next: PendingPermission | null): void {
    const previous = this.pending;
    if (previous?.id === next?.id) {
      this.pending = next;
      this.ctx?.requestRender();
      return;
    }

    this.notification?.cancel();
    this.notification = null;
    if (previous !== null) this.ctx?.popFocus(this);

    this.pending = next;
    this.resetDrafts();
    if (next !== null) {
      this.notification = armPermissionPromptNotification(next);
      this.ctx?.pushFocus(this);
    }
    this.ctx?.requestRender();
  }

  private resetDrafts(): void {
    this.cursor = 0;
    this.amendMode = false;
    this.amendDraft = "";
    this.prefixDraft = null;
    this.feedbackDraft = "";
    this.explaining = false;
  }

  /** `Ctrl+E explain` — the same chord hides it again once it is open. */
  private explainHint(): [string, string] {
    return ["Ctrl+E", this.explaining ? "hide explanation" : "explain"];
  }

  /** Names the mode the cycle key would leave from, so the step is never blind. */
  private modeHint(): [string, string] {
    return ["Shift+Tab", `mode: ${readStringViewBrokerState().permissionMode}`];
  }

  /** The explanation section, when it is showing, with its blank line above. */
  private explanationBlock(
    pending: PendingPermission,
    options: PermissionOptionRow[],
    contentWidth: number,
  ): string[] {
    if (!this.explaining) return [];
    return ["", ...explanationLines({ pending, options, width: contentWidth }), ""];
  }

  private optionsFor(pending: PendingPermission): PermissionOptionRow[] {
    if (pending.toolName === "ExitPlanMode") {
      return planOptionsFor(pending.bypassAvailable ?? false);
    }
    const isDesign = pending.source?.name === "design";
    const mcp = isDesign ? null : mcpDisplayFor(pending);
    return buildGenericOptions(
      pending.rule,
      isDesign,
      pending.toolName,
      pending.readOnly ?? false,
      mcp === null ? null : { label: mcp.label, cwd: process.cwd() },
    );
  }

  private moveCursor(delta: number, count: number): void {
    if (count <= 0) return;
    this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta));
    this.ctx?.requestRender();
  }

  private dismiss(pending: PendingPermission, planFeedbackFocused: boolean): void {
    if (this.amendMode) {
      this.amendMode = false;
      this.amendDraft = "";
      this.ctx?.requestRender();
      return;
    }
    if (planFeedbackFocused) {
      this.cursor = 0;
      this.feedbackDraft = "";
      this.ctx?.requestRender();
      return;
    }
    if (pending.toolName === "ExitPlanMode") {
      answer(pending.id, PermissionResults.planFeedback(""));
    } else {
      answer(pending.id, PermissionResults.deny());
    }
  }

  private activate(
    pending: PendingPermission,
    options: PermissionOptionRow[],
    planFeedbackFocused: boolean,
  ): void {
    if (planFeedbackFocused) {
      answer(pending.id, PermissionResults.planFeedback(this.feedbackDraft));
      return;
    }
    const choice = options[this.cursor];
    if (choice !== undefined) this.answerWith(pending, choice.kind);
  }

  private answerWith(pending: PendingPermission, kind: PermissionOptionKind): void {
    answer(
      pending.id,
      resultFor(
        kind,
        this.ruleForKind(pending, kind),
        pending.toolName,
        this.amendDraft,
        pending.editDirectory,
        pending.suggestions,
      ),
    );
  }

  private isPrefixEditable(pending: PendingPermission): boolean {
    return (
      pending.toolName !== "ExitPlanMode" &&
      pending.source?.name !== "design" &&
      pending.toolName === "Bash" &&
      pending.rule !== null
    );
  }

  private prefixValue(pending: PendingPermission): string {
    return this.prefixDraft ?? (pending.rule === null ? "" : bashRuleContentOf(pending.rule));
  }

  private ruleForKind(pending: PendingPermission, kind: PermissionOptionKind): string | null {
    if (kind !== "allow_always" || !this.isPrefixEditable(pending)) return pending.rule;
    const draft = this.prefixDraft?.trim();
    return draft ? `Bash(${draft})` : pending.rule;
  }

  private renderGenericPanel(pending: PendingPermission, width: number): string[] {
    const contentWidth = Math.max(1, Math.floor(width) - CONTENT_PAD_X * 2);
    const options = this.optionsFor(pending);
    const isDesign = pending.source?.name === "design";
    const presentation = toolPresentation(pending, contentWidth);
    const display = userFacingToolName(pending.toolName);
    const title = isDesign
      ? `Allow ${display} for this design session?`
      : permissionTitle(presentation.title, pending.source);
    const body: string[] = [];

    if (isDesign) {
      body.push(...styledRawLines(toolSignature(pending), contentWidth, Color.text));
      body.push("");
    } else {
      body.push(...presentation.body);
      if (presentation.warning !== null) {
        body.push("");
        body.push(
          ...styledProseLines(
            `${Glyph.warning} ${presentation.warning}`,
            contentWidth,
            Color.warning,
          ),
        );
      }
      body.push("");
      body.push(...styledProseLines(presentation.question, contentWidth, Color.text));
      body.push("");
    }

    body.push(...this.explanationBlock(pending, options, contentWidth));

    for (let index = 0; index < options.length; index++) {
      const option = options[index]!;
      const selected = index === this.cursor;
      body.push(this.renderOptionRow(pending, option, selected, contentWidth));
    }

    const quickRange = options.length === 2 ? "1-2" : `1-${options.length}`;
    const footerHints: [string, string][] = this.amendMode
      ? [
          ["type", "feedback"],
          ["Enter", "confirm"],
          ["Esc", "back"],
          ["↑↓", "select"],
        ]
      : [
          ["↑↓", "select"],
          ["Enter", "confirm"],
          ["Esc", "cancel"],
          [quickRange, "quick"],
          ...(isDesign ? [] : ([["Tab", "amend"]] as [string, string][])),
          this.explainHint(),
          this.modeHint(),
        ];
    const spec: FooterPanelSpec = {
      title,
      flushTop: true,
      footerHints,
      body,
    };
    return renderFooterPanel(spec, width);
  }

  private renderOptionRow(
    pending: PendingPermission,
    option: PermissionOptionRow,
    selected: boolean,
    contentWidth: number,
  ): string {
    const labelBudget = Math.max(1, contentWidth - 2);
    if (option.kind === "allow_always" && this.isPrefixEditable(pending)) {
      const value = this.prefixValue(pending);
      const display = inputRowDisplay({
        prefix: `${option.key}. Yes, and don't ask again for: `,
        value,
        placeholder: PREFIX_PLACEHOLDER,
        width: labelBudget,
        cursor: selected,
        selected,
      });
      return renderPanelRowLine(
        { label: display.label, styledLabel: display.styledLabel, selected },
        contentWidth,
        labelBudget,
      );
    }

    const amendHere =
      this.amendMode && selected && (option.kind === "allow" || option.kind === "deny");
    if (amendHere) {
      const display = inputRowDisplay({
        prefix: `${option.key}. ${option.label}, `,
        value: this.amendDraft,
        placeholder: amendPlaceholderFor(option.kind),
        width: labelBudget,
        cursor: true,
        selected: true,
      });
      return renderPanelRowLine(
        { label: display.label, styledLabel: display.styledLabel, selected: true },
        contentWidth,
        labelBudget,
      );
    }

    const label = truncateEllipsis(`${option.key}. ${option.label}`, labelBudget);
    return renderPanelRowLine({ label, selected }, contentWidth, labelBudget);
  }

  private renderPlanPanel(pending: PendingPermission, width: number): string[] {
    const contentWidth = Math.max(1, Math.floor(width) - CONTENT_PAD_X * 2);
    const options = this.optionsFor(pending);
    const feedbackFocused = options[this.cursor]?.kind === "plan_feedback";
    const body: string[] = [renderTextWithStyles("Here is the plan:", { color: Color.muted })];
    const plan = extractPlan(pending.input);

    if (plan !== null) {
      body.push("");
      body.push(...renderMarkdownLines(plan, contentWidth));
    }
    body.push("");
    body.push(...styledProseLines(PLAN_QUESTION, contentWidth, Color.text));
    body.push("");
    body.push(...this.explanationBlock(pending, options, contentWidth));

    for (let index = 0; index < options.length; index++) {
      const option = options[index]!;
      const selected = index === this.cursor;
      body.push(optionRowLine(option, selected, contentWidth));
      if (selected && option.kind === "plan_feedback") {
        const display = inputRowDisplay({
          prefix: "",
          value: this.feedbackDraft,
          placeholder: "Tell agent what to change",
          width: Math.max(1, contentWidth - 2),
          cursor: true,
          selected: true,
        });
        body.push(
          renderPanelRowLine(
            { label: display.label, styledLabel: display.styledLabel, selected: true },
            contentWidth,
            Math.max(1, contentWidth - 2),
          ),
        );
      }
    }

    const spec: FooterPanelSpec = {
      title: "Ready to code?",
      accent: Color.modePlan,
      footerHints: [...planFooterHints(feedbackFocused), this.explainHint()],
      body,
    };
    return renderFooterPanel(spec, width);
  }
}

function optionRowLine(
  option: PermissionOptionRow,
  selected: boolean,
  contentWidth: number,
): string {
  const labelBudget = Math.max(1, contentWidth - 2);
  const label = truncateEllipsis(`${option.key}. ${option.label}`, labelBudget);
  return renderPanelRowLine({ label, selected }, contentWidth, labelBudget);
}

function amendPlaceholderFor(kind: PermissionOptionKind): string {
  return kind === "deny"
    ? "and tell Otherside what to do differently"
    : "and tell Otherside what to do next";
}

function planFooterHints(feedbackFocused: boolean): [string, string][] {
  if (feedbackFocused) {
    return [
      ["type", "feedback"],
      ["Enter", "submit"],
      ["Esc", "clear"],
      ["↑↓", "change option"],
    ];
  }
  return [
    ["↑↓", "select"],
    ["Enter", "confirm"],
    ["Esc", "cancel"],
    ["1-3", "quick"],
  ];
}

function inputRowDisplay(options: {
  prefix: string;
  value: string;
  placeholder: string;
  width: number;
  cursor: boolean;
  selected: boolean;
}): InputRowDisplay {
  const cursorText = options.cursor ? Glyph.blockThreeEighths : "";
  const available = Math.max(0, options.width - stringWidth(cursorText));
  const shownValue = options.value.length > 0 ? options.value : options.placeholder;
  const prefix = truncateEllipsis(options.prefix, available);
  const valueBudget = Math.max(0, available - stringWidth(prefix));
  const value = tailEllipsis(shownValue, valueBudget);
  const label = prefix + value + cursorText;
  const prefixColor = options.selected ? Color.panelAccent : Color.muted;
  const valueColor = options.value.length > 0 && options.selected ? Color.text : Color.muted;
  return {
    label,
    styledLabel:
      renderTextWithStyles(prefix, { color: prefixColor, bold: options.selected }) +
      renderTextWithStyles(value, { color: valueColor }) +
      renderTextWithStyles(cursorText, { color: Color.muted }),
  };
}

function tailEllipsis(value: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;
  if (width === 1) return "…";
  return `…${value.slice(-(width - 1))}`;
}
