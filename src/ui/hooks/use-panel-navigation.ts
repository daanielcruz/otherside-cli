import type { Key } from "@/ink";
import { useInput } from "@/ink";
import { layerOwnsInput, type ModalLayer, useTopModalLayer } from "@/ui/keybindings/modal-focus.ts";

export interface PanelTabsNav {
  count: number;
  active: number;
  onChange: (next: number) => void;
}

export interface PanelRowsNav {
  count: number;
  selected: number;
  onChange: (next: number) => void;
}

export interface PanelNavigation {
  onClose: () => void;
  tabs?: PanelTabsNav | undefined;
  rows?: PanelRowsNav | undefined;
  onActivate?: (() => void) | undefined;
  onBack?: (() => boolean) | undefined;
  isRoot?: boolean | undefined;
  isActive?: boolean | undefined;
  layer?: ModalLayer | undefined;
  skipEsc?: boolean | undefined;
  onKey?: ((input: string, key: Key) => boolean) | undefined;
}

import { clamp } from "@/kernel/std/math.ts";

function step(nav: { count: number; index: number; onChange: (next: number) => void }): void {
  const next = clamp(nav.index, 0, nav.count - 1);
  if (next === nav.index) nav.onChange(next);
}

export function usePanelNavigation(nav: PanelNavigation): void {
  const topLayer = useTopModalLayer();
  useInput((input, key) => {
    if (nav.isActive === false) return;
    if (!layerOwnsInput(nav.layer ?? "overlay", topLayer)) return;

    if (key.escape && !nav.skipEsc) {
      if (nav.onBack?.()) return;
      nav.onClose();
      return;
    }

    if (nav.onKey?.(input, key)) return;

    if (key.return) {
      nav.onActivate?.();
      return;
    }

    if (key.upArrow && nav.rows) {
      step({ count: nav.rows.count, index: nav.rows.selected - 1, onChange: nav.rows.onChange });
      return;
    }

    if (key.downArrow && nav.rows) {
      step({ count: nav.rows.count, index: nav.rows.selected + 1, onChange: nav.rows.onChange });
      return;
    }

    if (key.rightArrow && nav.tabs) {
      const next = (nav.tabs.active + 1) % nav.tabs.count;
      nav.tabs.onChange(next);
      return;
    }

    if (key.tab && nav.tabs) {
      const next = (nav.tabs.active + 1) % nav.tabs.count;
      nav.tabs.onChange(next);
      return;
    }

    if (key.leftArrow) {
      if (nav.tabs) {
        const next = (nav.tabs.active - 1 + nav.tabs.count) % nav.tabs.count;
        nav.tabs.onChange(next);
        return;
      }
      if (nav.onBack?.()) return;
      if (!nav.isRoot) nav.onClose();
    }
  });
}
