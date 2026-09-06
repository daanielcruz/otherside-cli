import type { SlashCommand } from "@/commands/index.ts";
import { listCompletions, looksLikeCommand, lookup } from "@/commands/index.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { getPromptText, promptStore, setPromptText } from "@/store/prompt/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import type { StringFocusTarget } from "@/terminal-runtime/string-view/focus.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import {
  claimPromptMenu,
  PROMPT_MENU_ROWS,
  promptMenuSelection,
  promptMenuWindow,
  releasePromptMenu,
} from "@/ui/input/prompt-menu.ts";
import { Color } from "@/ui/theme/theme.ts";

export class StringViewAutocomplete implements StringComponent {
  private options: SlashCommand[] = [];
  private selected = 0;
  private query: string | null = null;
  private noMatchQuery: string | undefined;
  private dismissedText: string | null = null;
  private open = false;
  private focused = false;
  private context: StringViewContext | undefined;
  private unsub: (() => void) | undefined;

  constructor(private readonly fallbackTarget?: StringFocusTarget) {}

  mount(ctx: StringViewContext): void {
    this.unmount();
    this.context = ctx;
    this.syncFromPrompt();
    this.unsub = promptStore.subscribe(() => this.syncFromPrompt());
    ctx.requestRender();
  }

  unmount(): void {
    this.unsub?.();
    this.unsub = undefined;
    this.open = false;
    releasePromptMenu(this);
    this.releaseFocus();
    this.context = undefined;
  }

  render(width: number): string[] {
    if (!this.open) return [];
    if (this.options.length === 0) {
      const label = renderTextWithStyles(`No commands match "/${this.noMatchQuery ?? ""}"`, {
        color: Color.muted,
      });
      return [label, ...Array.from({ length: PROMPT_MENU_ROWS - 1 }, () => "")];
    }

    const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
    const nameWidth = Math.min(32, Math.max(16, Math.floor((columns - 6) * 0.4)));
    const descriptionWidth = Math.max(12, columns - nameWidth - 8);
    const { start, visible } = promptMenuWindow(this.options, this.selected);
    const query = this.query?.split(/\s+/, 1)[0] ?? "";
    const rows = visible.map((option, offset) => {
      const selected = start + offset === this.selected;
      if (selected) {
        // The selected row reads as one highlighted line, name and description alike.
        return renderTextWithStyles(
          `/${option.name}`.padEnd(nameWidth) +
            truncateEllipsis(option.description, descriptionWidth),
          { color: Color.highlight },
        );
      }
      return (
        matchLitText(`/${option.name}`.padEnd(nameWidth), query) +
        matchLitText(truncateEllipsis(option.description, descriptionWidth), query)
      );
    });
    while (rows.length < PROMPT_MENU_ROWS) rows.push("");
    return rows;
  }

  handleKey(key: KeyEventData): void {
    if (!this.open) return;
    const nextSelection = promptMenuSelection(key, this.selected, this.options.length);
    if (nextSelection !== undefined) {
      // A lone option has nowhere to move to, so the arrows stay with the prompt and
      // recall history instead of dying on a selection that cannot change. Recalling a
      // slash command from history reopens this menu, which is how the keys got stuck.
      if (this.options.length <= 1) {
        this.fallbackTarget?.handleKey(key);
        return;
      }
      this.selected = nextSelection;
      this.context?.requestRender();
      return;
    }
    if (key.name === "tab") {
      const option = this.options[this.selected];
      if (!option) return;
      const accepted = `/${option.name}`;
      this.dismissedText = accepted;
      setPromptText(accepted);
      this.close();
      return;
    }
    if (key.name === "return") {
      const option = this.options[this.selected];
      if (!option) {
        this.close();
        return;
      }
      const accepted = `/${option.name}`;
      this.dismissedText = accepted;
      setPromptText(accepted);
      this.close();
      // A single Enter runs the highlighted command — forward the keystroke to the
      // prompt so it submits the accepted text without a second Enter.
      this.fallbackTarget?.handleKey(key);
      return;
    }
    if (key.name === "escape") {
      this.dismiss();
      return;
    }
    const fallback = this.fallbackTarget;
    this.dismissedText = getPromptText();
    this.close();
    fallback?.handleKey(key);
  }

  private syncFromPrompt(): void {
    const prompt = promptStore.getState();
    const text = prompt.text;
    if (text !== this.dismissedText) this.dismissedText = null;
    const nextQuery = text.startsWith("/") && !prompt.bashMode ? text.slice(1) : null;
    if (nextQuery !== this.query) this.selected = 0;
    this.query = nextQuery;
    this.options = completionOptions(nextQuery);
    this.noMatchQuery = noMatchQuery(nextQuery, this.options);
    const nextOpen =
      text !== this.dismissedText && (this.options.length > 0 || this.noMatchQuery !== undefined);
    this.setOpen(nextOpen);
  }

  private dismiss(): void {
    this.dismissedText = getPromptText();
    this.close();
  }

  private close(): void {
    this.setOpen(false);
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

/**
 * Muted text with the first case-insensitive occurrence of the query lit in the
 * highlight colour, so every row shows why it matched the search.
 */
function matchLitText(text: string, query: string): string {
  const at = query.length === 0 ? -1 : text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return renderTextWithStyles(text, { color: Color.muted });
  return (
    (at > 0 ? renderTextWithStyles(text.slice(0, at), { color: Color.muted }) : "") +
    renderTextWithStyles(text.slice(at, at + query.length), { color: Color.highlight }) +
    (at + query.length < text.length
      ? renderTextWithStyles(text.slice(at + query.length), { color: Color.muted })
      : "")
  );
}

function completionOptions(query: string | null): SlashCommand[] {
  if (query === null) return [];
  const token = query.split(/\s+/, 1)[0] ?? "";
  const hasArgs = query.slice(token.length).trim().length > 0;
  return hasArgs || /\s/.test(query) ? [] : listCompletions(token);
}

function noMatchQuery(query: string | null, options: readonly SlashCommand[]): string | undefined {
  if (query === null || query.length === 0 || options.length > 0) return undefined;
  const commandToken = query.split(/\s+/, 1)[0] ?? "";
  const hasArgs = query.slice(commandToken.length).trim().length > 0;
  const matched = /\s/.test(query) ? lookup(commandToken) : undefined;
  return !matched && looksLikeCommand(commandToken) && !hasArgs ? query : undefined;
}
