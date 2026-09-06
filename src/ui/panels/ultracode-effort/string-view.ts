import { effortLevelsForModel } from "@/engine/model/catalog.ts";
import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { dispatch } from "@/store/app-store/index.ts";
import { recordPanelCommitRef } from "@/store/turn-run/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import {
  FALLBACK_TERMINAL_ROWS,
  type ListPanelSpec,
  renderListPanel,
} from "@/ui/chrome/string-view-panel.ts";
import {
  isUltracodeChoice,
  type UltracodeEffortChoice,
} from "@/ui/panels/effort/ultracode-choice.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";

/**
 * Ultracode effort picker on the string model. Lists model-supported effort levels,
 * Enter enables ultracode at the chosen effort (config + broker), Escape closes.
 * Left/right mirror ↑/↓ so the selection can be stepped either way.
 */
class UltracodeEffortPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private readonly levels: UltracodeEffortChoice[];
  private idx: number;

  constructor(private readonly close: () => void) {
    const state = readStringViewBrokerState();
    this.levels = effortLevelsForModel({
      provider: state.provider,
      model: state.model,
    }).filter(isUltracodeChoice);
    this.idx = resolveInitialIdx(this.levels, loadConfigSync().ultracodeEffort ?? "high");
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
      command: "/effort ultracode",
      title: "Ultracode effort",
      subtitle: "Which ultracode effort do you want? (saved to config)",
      items: this.levels.map((level) => ({ id: level, label: level })),
      cursor: this.idx,
      maxRows: this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS,
      footerHints: [
        ["↑/↓", "select"],
        ["Enter", "confirm"],
        ["Esc", "cancel"],
      ],
      emptyLabel: "no effort levels for this model",
    };
    return renderListPanel(spec, width);
  }

  handleKey(key: KeyEventData): void {
    switch (key.name) {
      case "up":
      case "left":
        this.move(-1);
        return;
      case "down":
      case "right":
        this.move(1);
        return;
      case "return":
        this.commit();
        return;
      case "escape":
        this.close();
        return;
    }
  }

  private move(delta: number): void {
    if (this.levels.length === 0) return;
    this.idx = Math.max(0, Math.min(this.levels.length - 1, this.idx + delta));
    this.ctx?.requestRender();
  }

  private commit(): void {
    const chosen = this.levels[this.idx];
    if (chosen === undefined) return;

    void updateConfig((config) => {
      config.ultracodeEffort = chosen;
      config.ultracode = true;
    });
    applyBrokerState({ ultracode: true, effort: chosen });
    recordPanelCommitRef.current("effort", `ultracode with ${chosen} effort`);
    this.close();
  }
}

function applyBrokerState(patch: Partial<BrokerState>): void {
  dispatch({
    type: "engine/setSlice",
    key: "broker",
    value: { ...readStringViewBrokerState(), ...patch },
  });
}

function resolveInitialIdx(levels: EffortLevel[], desired: EffortLevel): number {
  const desiredIdx = levels.indexOf(desired);
  if (desiredIdx >= 0) return desiredIdx;
  const highIdx = levels.indexOf("high");
  return highIdx >= 0 ? highIdx : Math.max(0, levels.length - 1);
}

export function createUltracodeEffortPanel(close: () => void, _props?: unknown): StringViewPanel {
  return new UltracodeEffortPanel(close);
}
