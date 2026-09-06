import { killBackground, listBackground } from "@/engine/tools/builtins/bash.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import {
  FALLBACK_TERMINAL_ROWS,
  type ListPanelSpec,
  renderListPanel,
} from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const COMMAND_CLIP = 60;
const POLL_MS = 500;

type RunningShell = ReturnType<typeof runningShells>[number];

/**
 * Running background shells on the string model. One row per running shell (status
 * bullet, id, elapsed, command, exit code), polled once a second-ish so the elapsed
 * clock advances. `x` stops the selected shell; `q` or Escape closes.
 */
class BashesPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private cursor = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly close: () => void) {}

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.timer = setInterval(() => ctx.requestRender(), POLL_MS);
    ctx.requestRender();
  }

  unmount(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const shells = runningShells();
    const spec: ListPanelSpec = {
      command: "/bashes",
      title: "Bashes",
      items: shells.map((shell) => ({ id: shell.id, ...shellRow(shell) })),
      cursor: this.cursor,
      maxRows: this.terminalRows(),
      footerHints: [
        ["↑↓", "navigate"],
        ["x", "stop"],
        ["Esc", "close"],
      ],
    };
    return renderListPanel(spec, width);
  }

  private terminalRows(): number {
    return this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
  }

  handleKey(key: KeyEventData): void {
    const shells = runningShells();
    switch (key.name) {
      case "up":
        this.cursor = Math.max(0, this.cursor - 1);
        this.ctx?.requestRender();
        return;
      case "down":
        this.cursor = Math.min(Math.max(0, shells.length - 1), this.cursor + 1);
        this.ctx?.requestRender();
        return;
      case "escape":
        this.close();
        return;
    }
    if (key.sequence === "q") {
      this.close();
      return;
    }
    if (key.sequence === "x") {
      const selected = shells[this.cursor];
      if (selected) killBackground(selected.id);
      this.ctx?.requestRender();
    }
  }
}

function runningShells() {
  return listBackground().filter((shell) => shell.status === "running");
}

function shellRow(shell: RunningShell): { label: string; styledLabel: string } {
  const elapsed = Math.floor((Date.now() - shell.startedAt) / 1000);
  const command = shell.command.slice(0, COMMAND_CLIP);
  const exit = shell.exitCode !== null ? ` exit ${shell.exitCode}` : "";
  const label = `${Glyph.bulletFilled} ${shell.id} · ${elapsed}s · ${command}${exit}`;
  const styledLabel =
    renderTextWithStyles(`${Glyph.bulletFilled} `, { color: Color.success }) +
    renderTextWithStyles(shell.id, { color: Color.panelAccent }) +
    renderTextWithStyles(` · ${elapsed}s · `, { color: Color.muted }) +
    renderTextWithStyles(command, { color: Color.text }) +
    (exit === ""
      ? ""
      : renderTextWithStyles(exit, {
          color: shell.exitCode === 0 ? Color.success : Color.error,
        }));
  return { label, styledLabel };
}

export function createBashesPanel(close: () => void): StringViewPanel {
  return new BashesPanel(close);
}
