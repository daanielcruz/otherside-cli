import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import {
  FALLBACK_TERMINAL_ROWS,
  type ListPanelSpec,
  renderListPanel,
} from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";

/** Opener payload — matches the deleted React `QuotaOverlayProps`. */
export interface QuotaOverlayProps {
  onSwitchModel?: () => void;
  onDismiss?: () => void;
}

const OPTIONS = [
  { key: "switch", label: "Switch model" },
  { key: "stop", label: "Stop and wait for limit to reset" },
] as const;

/**
 * Quota exhausted chooser on the string model. Two options (switch model / stop and
 * wait); Enter or 1/2 activates, Escape (or Ctrl+C) dismisses. Callbacks come from the
 * opener payload when present, else fall back to `close()`.
 */
class QuotaPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private selected = 0;
  private readonly onSwitchModel: () => void;
  private readonly onDismiss: () => void;

  constructor(close: () => void, props?: QuotaOverlayProps) {
    this.onSwitchModel = props?.onSwitchModel ?? close;
    this.onDismiss = props?.onDismiss ?? close;
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    ctx.requestRender();
  }

  unmount(): void {
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const spec: ListPanelSpec = {
      title: "What do you want to do?",
      items: OPTIONS.map((opt, idx) => ({
        id: opt.key,
        label: `${idx + 1}. ${opt.label}`,
      })),
      cursor: this.selected,
      maxRows: this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS,
      footerHints: [
        ["Enter", "confirm"],
        ["Esc", "cancel"],
      ],
    };
    return renderListPanel(spec, width);
  }

  handleKey(key: KeyEventData): void {
    if (key.ctrl && key.name === "c") {
      this.onDismiss();
      return;
    }

    switch (key.name) {
      case "up":
        this.move(-1);
        return;
      case "down":
        this.move(1);
        return;
      case "tab":
        this.move(key.shift ? -1 : 1);
        return;
      case "return":
        this.activate();
        return;
      case "escape":
        this.onDismiss();
        return;
    }

    if (key.sequence === "1") {
      this.selected = 0;
      this.onSwitchModel();
      return;
    }
    if (key.sequence === "2") {
      this.selected = 1;
      this.onDismiss();
      return;
    }
  }

  private move(delta: number): void {
    const n = OPTIONS.length;
    this.selected = (this.selected + delta + n) % n;
    this.ctx?.requestRender();
  }

  private activate(): void {
    const choice = OPTIONS[this.selected]?.key;
    if (choice === "switch") this.onSwitchModel();
    else if (choice === "stop") this.onDismiss();
  }
}

function narrowProps(props: unknown): QuotaOverlayProps | undefined {
  if (typeof props !== "object" || props === null) return undefined;
  const record = props as Record<string, unknown>;
  const out: QuotaOverlayProps = {};
  if (typeof record.onSwitchModel === "function") {
    out.onSwitchModel = record.onSwitchModel as () => void;
  }
  if (typeof record.onDismiss === "function") {
    out.onDismiss = record.onDismiss as () => void;
  }
  return out;
}

export function createQuotaPanel(close: () => void, props?: unknown): StringViewPanel {
  return new QuotaPanel(close, narrowProps(props));
}
