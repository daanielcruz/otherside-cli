import { isAwaitingDecision } from "@/kernel/channels/awaiting-decision.ts";
import { type CaretPosition, StringContainer } from "@/terminal-runtime/string-view/component.js";
import { FRAME_BOTTOM_MARGIN } from "@/ui/chrome/string-view-chrome-region.ts";

/**
 * The rows under the decision prompts: the queue preview, the prompt bar with its
 * menus, the status rows and the running-agents strip. While a permission request or
 * a question is open the reader answers it rather than the prompt, so the dock gives
 * its rows up, keeping only the frame's bottom margin, and takes them back on close.
 */
export class StringViewPromptDock extends StringContainer {
  private stowed = false;

  override render(width: number): string[] {
    this.stowed = isAwaitingDecision();
    if (this.stowed) return [...FRAME_BOTTOM_MARGIN];
    return super.render(width);
  }

  override caret(width: number): CaretPosition | null {
    if (this.stowed) return null;
    return super.caret(width);
  }
}
