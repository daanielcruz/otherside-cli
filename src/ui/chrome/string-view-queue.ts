import { subscribeAgentSteers } from "@/engine/background/subagents/fork/steering.ts";
import { appStore } from "@/store/app-store/index.ts";
import { queueStore } from "@/store/queue-store/index.ts";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { viewedThread } from "@/ui/app/viewed-thread.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { wrapOutputRows } from "@/ui/transcript/presentation.ts";

const QUEUE_LEFT_INDENT = 2;
const QUEUE_INNER_PAD = 1;

export class StringViewQueue implements StringComponent {
  private readonly unsubs: (() => void)[] = [];

  mount(ctx: StringViewContext): void {
    this.unmount();
    // The region answers for whichever thread is on screen, so it repaints on
    // the leader's queue, on an open agent's steer queue, and on the surface
    // switch itself.
    this.unsubs.push(
      queueStore.subscribe(ctx.requestRender),
      appStore.subscribe(ctx.requestRender),
      subscribeAgentSteers(ctx.requestRender),
    );
  }

  unmount(): void {
    for (const unsub of this.unsubs.splice(0)) unsub();
  }

  render(width: number): string[] {
    // The preview belongs to the thread on screen: the leader's queued turn
    // input, or an open agent's pending steers until its turn drains them.
    const messages = viewedThread().queued;
    if (messages.length === 0) return [];
    const columns = Math.max(1, Math.floor(width));
    const boxWidth = Math.max(1, columns - QUEUE_LEFT_INDENT);
    const prefixWidth = stringWidth(Glyph.chevron);
    const textBudget = Math.max(1, boxWidth - QUEUE_INNER_PAD - prefixWidth);
    const lines: string[] = [];
    for (const message of messages) {
      const wrapped = wrapOutputRows(message.expanded || message.text, textBudget);
      const rows = wrapped.length > 0 ? wrapped : [""];
      rows.forEach((line, index) => {
        lines.push(queueRow(line, index === 0, boxWidth));
      });
    }
    return lines;
  }
}

function queueRow(text: string, showPrefix: boolean, boxWidth: number): string {
  const prefix = showPrefix ? Glyph.chevron : " ".repeat(stringWidth(Glyph.chevron));
  const bodyWidth = Math.max(0, boxWidth - stringWidth(prefix));
  const fill = Math.max(0, bodyWidth - stringWidth(text));
  return (
    " ".repeat(QUEUE_LEFT_INDENT) +
    renderTextWithStyles(prefix, { color: Color.badgePrefix, backgroundColor: Color.inverseBg }) +
    renderTextWithStyles(text + " ".repeat(fill), {
      color: Color.queueText,
      backgroundColor: Color.inverseBg,
    })
  );
}
