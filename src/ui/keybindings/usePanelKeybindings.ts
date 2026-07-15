import { useRegisterKeybindingContext } from "@/ui/keybindings/keybinding-context.tsx";
import type { KeybindingContextName } from "@/ui/keybindings/types.ts";
import { useKeybindings } from "@/ui/keybindings/useKeybinding.ts";

export const PANEL_DEFAULTS_CONTEXT: KeybindingContextName = "PanelDefaults";

export interface PanelKeybindingHandlers {
  onUp?: () => void;
  onDown?: () => void;
  onLeft?: () => void;
  onRight?: () => void;
  onTab?: () => void;
  onShiftTab?: () => void;
  onEnter?: () => void;
  onBack?: () => void;
}

export interface PanelKeybindingOptions {
  context: KeybindingContextName;
  isActive?: boolean;
}

export function usePanelKeybindings(
  handlers: PanelKeybindingHandlers,
  options: PanelKeybindingOptions,
): void {
  useRegisterKeybindingContext(PANEL_DEFAULTS_CONTEXT);

  const actionHandlers: Record<string, () => void | false | Promise<void>> = {};
  if (handlers.onUp) actionHandlers["panel:up"] = handlers.onUp;
  if (handlers.onDown) actionHandlers["panel:down"] = handlers.onDown;
  if (handlers.onLeft) actionHandlers["panel:left"] = handlers.onLeft;
  if (handlers.onRight) actionHandlers["panel:right"] = handlers.onRight;
  if (handlers.onTab) actionHandlers["panel:tab"] = handlers.onTab;
  if (handlers.onShiftTab) actionHandlers["panel:shiftTab"] = handlers.onShiftTab;
  if (handlers.onEnter) actionHandlers["panel:enter"] = handlers.onEnter;
  if (handlers.onBack) actionHandlers["panel:back"] = handlers.onBack;

  useKeybindings(actionHandlers, options);
}
