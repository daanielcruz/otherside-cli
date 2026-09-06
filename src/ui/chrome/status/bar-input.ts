import type { BrokerState } from "@/store/app-store/broker.ts";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.js";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface PermissionChip {
  symbol: string;
  text: string;
  color: TerminalColor;
}

export function permissionChip(state: BrokerState): PermissionChip | null {
  const fastForward = Glyph.fastForward.repeat(2);
  if (state.permissionMode === "yolo") {
    return { symbol: fastForward, text: "yolo mode on", color: Color.modeYolo };
  }
  if (state.permissionMode === "plan") {
    return { symbol: Glyph.pause, text: "plan mode on", color: Color.modePlan };
  }
  if (state.permissionMode === "accept-edits") {
    return { symbol: fastForward, text: "accept edits on", color: Color.modeAccept };
  }
  return null;
}
