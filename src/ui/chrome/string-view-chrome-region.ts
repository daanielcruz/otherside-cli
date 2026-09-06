import { isPromptMenuOpen, promptStore } from "@/store/prompt/index.ts";
import {
  StringContainer,
  type StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { StringViewStatusBar } from "@/ui/chrome/status/string-view-status-bar.ts";
import { StringViewStatusLine } from "@/ui/chrome/status/string-view-status-line.ts";

export class StringViewChromeRegion extends StringContainer {
  private unsubPrompt: (() => void) | undefined;

  constructor() {
    super();
    this.addChild(new StringViewStatusLine());
    this.addChild(new StringViewStatusBar());
  }

  override mount(ctx: StringViewContext): void {
    super.mount(ctx);
    this.unsubPrompt?.();
    this.unsubPrompt = promptStore.subscribe(ctx.requestRender);
  }

  override unmount(): void {
    this.unsubPrompt?.();
    this.unsubPrompt = undefined;
    super.unmount();
  }

  override render(width: number): string[] {
    // The command menu owns the footer region while open; panels are compact and
    // keep the status and mode rows visible beneath them. The bottom margin is not
    // the footer's to hand over with it: it belongs to the frame's last row, and a
    // menu that displaced the status rows still has to clear the terminal's edge.
    if (isPromptMenuOpen()) return [...BOTTOM_MARGIN];
    return [...super.render(width), ...BOTTOM_MARGIN];
  }
}

/** Blank rows keeping whatever ends the frame clear of the terminal's bottom edge. */
const BOTTOM_MARGIN = ["", ""] as const;
