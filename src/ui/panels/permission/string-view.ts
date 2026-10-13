import { userFacingToolName } from "@/engine/tools/tool-label.ts";
import {
  answer,
  type PendingPermission,
  PermissionResults,
  subscribe,
} from "@/kernel/channels/permission.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { fieldWithCaret } from "@/ui/chrome/field-caret.ts";
import { typedText } from "@/ui/chrome/key-input.ts";
import { hintFor, hintPair } from "@/ui/chrome/panel-hints.ts";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { cycleStringViewPermissionMode } from "@/ui/chrome/status/string-view-state.ts";
import {
  panelDashedRuleLine,
  renderFooterPanel,
  renderPanelChoiceRowLines,
} from "@/ui/chrome/string-view-panel.ts";
import { armPermissionPromptNotification } from "@/ui/panels/permission/notification.ts";
import {
  bashRuleContentOf,
  buildGenericOptions,
  type LabelSegment,
  type PermissionOptionKind,
  type PermissionOptionRow,
  resultFor,
} from "@/ui/panels/permission/options.ts";
import {
  answeredByChoicesAlone,
  mcpDisplayFor,
  permissionTitle,
  styledProseLines,
  styledRawLines,
  toolPresentation,
  toolSignature,
} from "@/ui/panels/permission/tool-presentation.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

/** Columns the prompt's rows sit in from the frame's edge. */
const PANEL_PAD_X = 1;
/** Columns a call's own lines may take beyond the rows around them. */
const CALL_INSET_WIDTH = 2;
/** The frame assumed before the first render has measured one. */
const DEFAULT_FRAME_WIDTH = 80;
/** Cells kept clear beside a grant that names the working directory on its one row. */
const GRANT_LABEL_MARGIN = 16;

function grantLabelWidthFor(frameWidth: number): number {
  return frameWidth - GRANT_LABEL_MARGIN;
}
const PREFIX_LEAD = "Yes, and don't ask again for: ";
const PREFIX_PLACEHOLDER = "command prefix (e.g., npm run *)";

/** Footer surface for the head of the permission queue. */
export class StringViewPermissionPrompt implements StringComponent {
  private ctx: StringViewContext | undefined;
  private unsubscribe: (() => void) | undefined;
  private pending: PendingPermission | null = null;
  private cursor = 0;
  private amendMode = false;
  private amendDraft = "";
  private prefixDraft: string | null = null;
  private notification: ReturnType<typeof armPermissionPromptNotification> | null = null;
  private mountGeneration = 0;
  private frameWidth = process.stdout.columns ?? DEFAULT_FRAME_WIDTH;

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
    // Keys read the choices this frame drew, and a grant's label is fitted to it.
    this.frameWidth = Math.max(1, Math.floor(width));
    return this.renderGenericPanel(pending, width);
  }

  handleKey(key: KeyEventData): boolean {
    const pending = this.pending;
    if (pending === null) return false;
    this.notification?.markInteraction();

    const options = this.optionsFor(pending);
    const selected = options[this.cursor];
    const prefixFocused = this.isPrefixEditable(pending) && selected?.kind === "allow_always";

    const panelAction = panelKey(key);
    if (panelAction === "close" || panelAction === "back") {
      this.dismiss(pending);
      return true;
    }

    // The mode cycle belongs to the whole session, so it answers here too: the chat's
    // shift+tab cannot reach the keyboard while this surface holds it.
    if (key.shift && key.name === "tab") {
      cycleStringViewPermissionMode();
      this.ctx?.requestRender();
      return true;
    }

    if (key.name === "tab" && this.takesNote(pending)) {
      if (isAmendable(selected) || this.amendMode) {
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

    if (key.name === "up") {
      this.moveCursor(-1, options.length);
      return true;
    }
    if (key.name === "down") {
      this.moveCursor(1, options.length);
      return true;
    }
    if (panelAction === "confirm") {
      this.activate(pending, options);
      return true;
    }

    const direct = options.find((option) => option.key === input);
    if (direct !== undefined) {
      this.answerWith(pending, direct.kind);
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
  }

  /**
   * `Esc to cancel`, plus `Tab to amend` while the focused answer takes a note and
   * none is being written. The mode cycle still answers Shift+Tab here, unadvertised.
   */
  private footerHints(pending: PendingPermission, selected: PermissionOptionRow | undefined) {
    const offersAmend = this.takesNote(pending) && isAmendable(selected) && !this.amendMode;
    return [hintFor("cancel"), ...(offersAmend ? [hintFor("amend")] : [])].map(hintPair);
  }

  /** A yes or no may carry a note (Tab), except on a design prompt or a fetch. */
  private takesNote(pending: PendingPermission): boolean {
    return pending.source?.name !== "design" && !answeredByChoicesAlone(pending);
  }

  private optionsFor(pending: PendingPermission): PermissionOptionRow[] {
    const isDesign = pending.source?.name === "design";
    const mcp = isDesign ? null : mcpDisplayFor(pending);
    return buildGenericOptions({
      pending,
      isDesign,
      mcp: mcp === null ? null : { label: mcp.label, cwd: process.cwd() },
      grantLabelWidth: grantLabelWidthFor(this.frameWidth),
    });
  }

  private moveCursor(delta: number, count: number): void {
    if (count <= 0) return;
    this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta));
    this.ctx?.requestRender();
  }

  /** Esc refuses the call outright, a note being written or not. */
  private dismiss(pending: PendingPermission): void {
    answer(pending.id, PermissionResults.deny());
  }

  private activate(pending: PendingPermission, options: PermissionOptionRow[]): void {
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
        pending.rules,
      ),
    );
  }

  private isPrefixEditable(pending: PendingPermission): boolean {
    return (
      pending.source?.name !== "design" && pending.toolName === "Bash" && pending.rule !== null
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
    const frameWidth = Math.max(1, Math.floor(width));
    const contentWidth = Math.max(1, frameWidth - PANEL_PAD_X * 2);
    const options = this.optionsFor(pending);
    const isDesign = pending.source?.name === "design";
    const presentation = toolPresentation(pending, contentWidth - CALL_INSET_WIDTH);
    const display = userFacingToolName(pending.toolName);
    const title = isDesign
      ? `Allow ${display} for this design session?`
      : permissionTitle(presentation.title, pending.source);
    // Rows sit at the panel inset; a file preview's frame alone runs edge to edge.
    const rows: string[] = [];
    const place = (lines: readonly string[], inset = 0): void => {
      const lead = " ".repeat(PANEL_PAD_X + inset);
      for (const line of lines) rows.push(line.length > 0 ? lead + line : line);
    };

    if (isDesign) {
      place(styledRawLines(toolSignature(pending), contentWidth, Color.text), CALL_INSET_WIDTH);
      rows.push("");
    } else {
      place(presentation.body, presentation.bodyInset);
      if (presentation.preview !== null) {
        const rule = panelDashedRuleLine(frameWidth);
        rows.push(rule);
        place(presentation.preview);
        rows.push(rule);
      } else {
        rows.push("");
      }
      if (presentation.warning !== null) {
        place(
          styledProseLines(`${Glyph.warning} ${presentation.warning}`, contentWidth, Color.warning),
        );
        rows.push("");
      }
      if (presentation.reason !== null) {
        place(styledProseLines(presentation.reason, contentWidth, Color.text));
        rows.push("");
      }
      place(wrapProse(styledSegments(presentation.question, Color.text), contentWidth));
    }

    // A choice's label runs on to the frame's right edge before it wraps.
    const choiceWidth = frameWidth - PANEL_PAD_X;
    options.forEach((option, index) => {
      place(this.renderOptionRow(pending, option, index === this.cursor, choiceWidth));
    });

    const hints = answeredByChoicesAlone(pending)
      ? undefined
      : this.footerHints(pending, options[this.cursor]);
    return renderFooterPanel(
      {
        title,
        paddingX: PANEL_PAD_X,
        bodyPaddingX: 0,
        // A file prompt's path sits right under its title; any other call follows a blank row.
        flushTop: !isDesign && presentation.preview !== null,
        footerHints: hints,
        footerItalic: false,
        body: rows,
      },
      width,
    );
  }

  private renderOptionRow(
    pending: PendingPermission,
    option: PermissionOptionRow,
    selected: boolean,
    contentWidth: number,
  ): string[] {
    const row = { key: option.key, label: option.label, selected };
    if (option.kind === "allow_always" && this.isPrefixEditable(pending)) {
      const value = this.prefixValue(pending);
      const lead = renderTextWithStyles(PREFIX_LEAD, {
        color: selected ? Color.panelAccent : Color.text,
      });
      const field = selected
        ? fieldWithCaret(value, value.length, PREFIX_PLACEHOLDER)
        : renderTextWithStyles(value || PREFIX_PLACEHOLDER, {
            color: value ? Color.text : Color.muted,
          });
      return renderPanelChoiceRowLines({ ...row, styledLabel: lead + field }, contentWidth);
    }

    if (this.amendMode && selected && isAmendable(option)) {
      const lead = renderTextWithStyles(`${option.label}, `, { color: Color.panelAccent });
      const field = fieldWithCaret(
        this.amendDraft,
        this.amendDraft.length,
        amendPlaceholderFor(option.kind),
      );
      return renderPanelChoiceRowLines({ ...row, styledLabel: lead + field }, contentWidth);
    }

    if (option.segments !== undefined) {
      const color = selected ? Color.panelAccent : Color.text;
      return renderPanelChoiceRowLines(
        { ...row, styledLabel: styledSegments(option.segments, color) },
        contentWidth,
      );
    }
    return renderPanelChoiceRowLines({ ...row, singleLine: true }, contentWidth);
  }
}

function amendPlaceholderFor(kind: PermissionOptionKind): string {
  return kind === "deny"
    ? "and tell Otherside what to do differently"
    : "and tell Otherside what to do next";
}

/** The answers a note can ride on: the plain yes and the plain no. */
function isAmendable(option: PermissionOptionRow | undefined): boolean {
  return option?.kind === "allow" || option?.kind === "deny";
}

/** Label or question text in one color, with the parts it names set bold. */
function styledSegments(segments: readonly LabelSegment[], color: typeof Color.text): string {
  return segments
    .map((segment) =>
      renderTextWithStyles(segment.text, { color, ...(segment.bold ? { bold: true } : {}) }),
    )
    .join("");
}
