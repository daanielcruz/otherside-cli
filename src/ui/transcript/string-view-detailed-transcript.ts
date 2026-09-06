import { appStore, dispatch } from "@/store/app-store/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import type { StringFocusTarget } from "@/terminal-runtime/string-view/focus.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { Color } from "@/ui/theme/theme.ts";
import { DetailedTranscriptPager } from "@/ui/transcript/detailed-transcript-pager.ts";
import type { StringViewTranscript } from "@/ui/transcript/string-view-transcript.ts";
import { transcriptInputAction } from "@/ui/transcript/string-view-transcript-input.ts";

const FALLBACK_TERMINAL_ROWS = 24;
/** Rows the reader spends on its own chrome: one spacer plus the footer. */
const CHROME_ROWS = 2;

export function detailedTranscriptFooterText(showAll: boolean): string {
  return `Showing detailed transcript · ctrl+o to toggle · ctrl+e to ${showAll ? "collapse" : "show all"}`;
}

function searchRow(query: string): string {
  return (
    renderTextWithStyles(`/${query}`, { color: Color.muted }) +
    renderTextWithStyles(" ", { inverse: true })
  );
}

export class StringViewDetailedTranscript implements StringComponent, StringFocusTarget {
  private context: StringViewContext | undefined;
  private unsub: (() => void) | undefined;
  private focused = false;
  private active = false;
  private showAll = false;
  private readonly pager = new DetailedTranscriptPager();

  constructor(private readonly transcript: StringViewTranscript) {}

  mount(ctx: StringViewContext): void {
    this.unmount();
    this.context = ctx;
    this.syncFromStore();
    this.unsub = appStore.subscribe(() => this.syncFromStore());
  }

  unmount(): void {
    this.unsub?.();
    this.unsub = undefined;
    this.releaseFocus();
    this.context = undefined;
    this.active = false;
    this.showAll = false;
    this.pager.reset();
  }

  isActive(): boolean {
    return this.active;
  }

  render(width: number): string[] {
    if (!this.active) return [];
    this.pager.setContent(this.transcript.renderDetailed(width, this.showAll));
    const searching = this.pager.isSearching();
    const footer = renderTextWithStyles(detailedTranscriptFooterText(this.showAll), {
      color: Color.muted,
    });
    const body = this.pager.window(this.bodyRows(searching));
    return searching
      ? [...body, "", searchRow(this.pager.searchQuery()), footer]
      : [...body, "", footer];
  }

  handleKey(key: KeyEventData): boolean {
    if (!this.active) return false;
    if (this.pager.handleKey(key, this.bodyRows(this.pager.isSearching()))) {
      this.context?.requestRender();
      return true;
    }
    const action = transcriptInputAction(key, "detailed");
    if (action === null) return true;
    if (action === "toggle-screen") {
      dispatch({ type: "view/toggleTranscriptScreen" });
    } else if (action === "toggle-all") {
      dispatch({ type: "view/toggleAllTranscriptMessages" });
    } else {
      dispatch({ type: "view/exitTranscriptScreen" });
    }
    return true;
  }

  /** The reader owns the screen, so its window is the terminal minus its chrome. */
  private bodyRows(searching: boolean): number {
    const terminalRows = this.context?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
    return Math.max(1, terminalRows - CHROME_ROWS - (searching ? 1 : 0));
  }

  private syncFromStore(): void {
    const view = appStore.getState().view;
    const active = view.transcriptScreen === "detailed";
    const showAll = active && view.showAllTranscriptMessages;
    const changed = active !== this.active || showAll !== this.showAll;
    // Every screen change re-frames the content, so the window opens at the newest row.
    if (changed) this.pager.reset();
    this.active = active;
    this.showAll = showAll;
    if (active && !this.focused) {
      this.context?.pushFocus(this);
      this.focused = true;
    } else if (!active) {
      this.releaseFocus();
    }
    if (changed) this.context?.requestRender();
  }

  private releaseFocus(): void {
    if (!this.focused) return;
    this.context?.popFocus(this);
    this.focused = false;
  }
}
