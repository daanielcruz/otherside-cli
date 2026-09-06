import { type OverlayName, overlayStack, overlayStore } from "@/store/overlay-stack/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import type { StringFocusTarget } from "@/terminal-runtime/string-view/focus.js";
import { noteDismissal } from "@/ui/panels/dismissal-notice.ts";
import { createStringViewPanel, isPortedOverlay } from "@/ui/panels/string-view-registry.ts";
import type { OverlayOpenProps, StringViewPanel } from "@/ui/panels/string-view-types.ts";

/**
 * Hosts the top footer panel on the string model. It watches the overlay stack and,
 * when the top overlay has a string-view surface, mounts that panel with any open-time
 * props from the stack entry, claims focus so keys route to it, and renders its lines
 * in place of the chrome footer. When the overlay closes it tears the panel down and
 * returns focus to the prompt. Overlays without a string-view surface render nothing
 * here (keys stay with the prompt) until they are ported.
 */
export class StringViewOverlayHost implements StringComponent, StringFocusTarget {
  private ctx: StringViewContext | undefined;
  private unsub: (() => void) | undefined;
  private active: { name: OverlayName; panel: StringViewPanel } | undefined;
  private focused = false;

  mount(ctx: StringViewContext): void {
    this.unmount();
    this.ctx = ctx;
    this.unsub = overlayStore.subscribe(() => this.sync());
    this.sync();
  }

  unmount(): void {
    this.unsub?.();
    this.unsub = undefined;
    // Silent: the session is ending, and a line about a panel closing beneath
    // that is not something anyone will read.
    this.teardown();
    this.ctx = undefined;
  }

  render(width: number): string[] {
    return this.active ? this.active.panel.render(width) : [];
  }

  /** Whether the mounted panel is claiming the whole frame right now. */
  isFullscreen(): boolean {
    return this.active?.panel.fullscreen?.() === true;
  }

  handleKey(key: KeyEventData): void {
    this.active?.panel.handleKey(key);
  }

  private sync(): void {
    const stack = overlayStore.getState().openStack;
    const entry = stack[stack.length - 1];
    const top = entry !== undefined && isPortedOverlay(entry.name) ? entry.name : undefined;
    if (top === this.active?.name) return;
    // Only a panel that LEFT the stack was dismissed. One still on it was pushed
    // under a deeper panel, and the reader will come back to it.
    const closing = this.active?.name;
    const dismissed =
      closing !== undefined && !stack.some((open) => open.name === closing) ? closing : undefined;
    this.teardown();
    if (dismissed !== undefined) noteDismissal(dismissed);
    if (top !== undefined && this.ctx !== undefined) {
      const props = entry?.props as OverlayOpenProps<typeof top> | undefined;
      const panel = createStringViewPanel(top, () => overlayStack.closeTop(), props);
      panel.mount?.(this.ctx);
      this.active = { name: top, panel };
      this.ctx.pushFocus(this);
      this.focused = true;
    }
    this.ctx?.requestRender();
  }

  private teardown(): void {
    if (this.active) {
      this.active.panel.unmount?.();
      this.active = undefined;
    }
    if (this.focused) {
      this.ctx?.popFocus(this);
      this.focused = false;
    }
  }
}
