import type { TranscriptScreen } from "@/store/app-store/slices/view.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";

export type TranscriptInputAction = "toggle-screen" | "toggle-all" | "exit";

export function transcriptInputAction(
  key: Pick<KeyEventData, "ctrl" | "name">,
  screen: TranscriptScreen,
): TranscriptInputAction | null {
  if (key.ctrl && key.name === "o") return "toggle-screen";
  if (screen !== "detailed") return null;
  if (key.ctrl && key.name === "e") return "toggle-all";
  if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) return "exit";
  return null;
}
