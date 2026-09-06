import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { getPromptText, promptStore } from "@/store/prompt/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import {
  insertMention,
  insertMentionPrefix,
  longestMentionPrefix,
  type MentionCandidate,
  mentionSpanAtCaret,
  mentionSuggestions,
} from "@/ui/input/mention-completion.ts";
import { type MentionSources, mentionSources } from "@/ui/input/mention-sources.ts";
import {
  claimPromptMenu,
  PROMPT_MENU_ROWS,
  promptMenuSelection,
  promptMenuWindow,
  releasePromptMenu,
} from "@/ui/input/prompt-menu.ts";
import type { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";
import { Color } from "@/ui/theme/theme.ts";

export class StringViewMentionPicker implements StringComponent {
  private files: MentionCandidate[] = [];
  private options: MentionCandidate[] = [];
  private selected = 0;
  private query: string | null = null;
  private dismissedText: string | null = null;
  private open = false;
  private focused = false;
  private context: StringViewContext | undefined;
  private unsub: (() => void) | undefined;
  private loadEpoch = 0;

  constructor(
    private readonly prompt: StringViewPrompt,
    private readonly sources: MentionSources = mentionSources,
  ) {}

  mount(ctx: StringViewContext): void {
    this.unmount();
    this.context = ctx;
    this.syncFromPrompt();
    this.unsub = promptStore.subscribe(() => this.syncFromPrompt());
    const epoch = ++this.loadEpoch;
    void this.sources.loadFiles().then(
      (files) => {
        if (epoch !== this.loadEpoch || this.context === undefined) return;
        this.files = files;
        this.syncFromPrompt();
      },
      () => undefined,
    );
    ctx.requestRender();
  }

  unmount(): void {
    this.loadEpoch += 1;
    this.unsub?.();
    this.unsub = undefined;
    this.open = false;
    releasePromptMenu(this);
    this.releaseFocus();
    this.context = undefined;
  }

  render(width: number): string[] {
    if (!this.open) return [];
    const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
    const { start, visible } = promptMenuWindow(this.options, this.selected);
    const rows = visible.map((candidate, offset) => {
      const description = candidate.description?.replace(/\s+/g, " ").trim();
      const label = `${candidate.kind === "agent" ? "*" : "+"} ${candidate.value}${
        description ? ` – ${description}` : ""
      }`;
      return renderTextWithStyles(truncateEllipsis(label, columns), {
        color: start + offset === this.selected ? Color.highlight : Color.muted,
      });
    });
    while (rows.length < PROMPT_MENU_ROWS) rows.push("");
    return rows;
  }

  handleKey(key: KeyEventData): void {
    if (!this.open) return;
    const nextSelection = promptMenuSelection(key, this.selected, this.options.length, true);
    if (nextSelection !== undefined) {
      this.selected = nextSelection;
      this.context?.requestRender();
      return;
    }
    if (key.name === "tab") {
      this.acceptTab();
      return;
    }
    if (key.name === "return") {
      this.acceptSelection();
      return;
    }
    if (key.name === "escape") {
      this.dismissedText = getPromptText();
      this.setOpen(false);
      return;
    }
    this.dismissedText = getPromptText();
    this.setOpen(false);
    this.prompt.handleKey(key);
  }

  private acceptTab(): void {
    const span = mentionSpanAtCaret(
      this.prompt.getText(),
      this.prompt.getCaretOffset(),
      this.prompt.isBashMode(),
    );
    if (span === null) {
      this.setOpen(false);
      return;
    }
    const prefix = longestMentionPrefix(this.options);
    if (prefix.length <= span.query.length) {
      this.acceptSelection();
      return;
    }
    const insertion = insertMentionPrefix(this.prompt.getText(), span, prefix);
    this.prompt.applyEdit({ text: insertion.text, caret: insertion.caret });
  }

  private acceptSelection(): void {
    const candidate = this.options[this.selected];
    const span = mentionSpanAtCaret(
      this.prompt.getText(),
      this.prompt.getCaretOffset(),
      this.prompt.isBashMode(),
    );
    if (!candidate || !span) {
      this.setOpen(false);
      return;
    }
    const insertion = insertMention(this.prompt.getText(), span, candidate);
    this.dismissedText = insertion.text;
    this.prompt.applyEdit({ text: insertion.text, caret: insertion.caret });
    this.setOpen(false);
  }

  private syncFromPrompt(): void {
    const text = this.prompt.getText();
    if (text !== this.dismissedText) this.dismissedText = null;
    const span = mentionSpanAtCaret(text, this.prompt.getCaretOffset(), this.prompt.isBashMode());
    const nextQuery = span?.query ?? null;
    const selectedId = this.options[this.selected]?.id;
    const nextOptions =
      nextQuery === null
        ? []
        : mentionSuggestions(nextQuery, this.files, this.sources.listAgents());
    if (nextQuery !== this.query) {
      this.selected = 0;
    } else if (selectedId !== undefined) {
      this.selected = Math.max(
        0,
        nextOptions.findIndex((option) => option.id === selectedId),
      );
    } else {
      this.selected = Math.min(this.selected, Math.max(0, nextOptions.length - 1));
    }
    this.query = nextQuery;
    this.options = nextOptions;
    this.setOpen(text !== this.dismissedText && span !== null && nextOptions.length > 0);
  }

  private setOpen(open: boolean): void {
    const wasOpen = this.open;
    this.open = open;
    if (open && !this.focused) {
      this.context?.pushFocus(this);
      this.focused = true;
    } else if (!open) {
      this.releaseFocus();
    }
    if (open && !wasOpen) claimPromptMenu(this);
    if (!open && wasOpen) releasePromptMenu(this);
    this.context?.requestRender();
  }

  private releaseFocus(): void {
    if (!this.focused) return;
    this.context?.popFocus(this);
    this.focused = false;
  }
}
