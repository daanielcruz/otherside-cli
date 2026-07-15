export { default as render } from "@/terminal-runtime/host/mount-runtime.js";

import chalk from "chalk";
import inkInstances from "@/terminal-runtime/host/runtime-registry.js";
import type { TerminalColor } from "@/terminal-runtime/paint/style-model.js";
import { type ColorChannel, colorize } from "@/terminal-runtime/text/color-codes.js";

export const dim = (str: string): string => chalk.dim(str);

export function discardFrameBaseline(stdout: NodeJS.WriteStream = process.stdout): void {
  inkInstances.get(stdout)?.invalidatePrevFrame();
}

export function resolveColorSequence(
  color: TerminalColor | undefined,
  target: ColorChannel,
): { open: string; close: string } {
  const marker = "";
  const wrapped = colorize(marker, color, target);
  const idx = wrapped.indexOf(marker);
  if (idx < 0) return { open: "", close: "" };
  return { open: wrapped.slice(0, idx), close: wrapped.slice(idx + marker.length) };
}

export {
  inputLagTraceEnabled,
  recordInputLag,
  startEventLoopMonitor,
} from "@/devtools/render/instrumentation.ts";
export { usePaste } from "@/hooks/use-paste.ts";
export { useStdout } from "@/hooks/useStdout.ts";
export type {
  KeyStroke,
  TerminalKey as Key,
} from "@/terminal-runtime/input/input-signal.js";
export { subscribeTerminalThemeNotify } from "@/terminal-runtime/input/key-decoder.js";
export type { FrameMetrics } from "@/terminal-runtime/paint/frame-state.js";
export type {
  TerminalColor as Color,
  TerminalTextStyle as TextStyles,
} from "@/terminal-runtime/paint/style-model.js";
export { useIsScreenReaderEnabled } from "@/terminal-runtime/react/accessibility-state.js";
export { default as Box } from "@/terminal-runtime/react/flex-container.js";
export { RawSequence } from "@/terminal-runtime/react/raw-sequence.js";
export { default as Text } from "@/terminal-runtime/react/styled-text.js";
export { default as TerminalLink } from "@/terminal-runtime/react/terminal-link.js";
export { TimekeeperContext } from "@/terminal-runtime/react/time-source.js";
export { useCursorOwner } from "@/terminal-runtime/react/use-cursor-owner.js";
export { useIsTerminalFocused } from "@/terminal-runtime/react/use-focus-state.js";
export { useFrameClock } from "@/terminal-runtime/react/use-frame-clock.js";
export { default as useStdin } from "@/terminal-runtime/react/use-input-stream.js";
export { default as useInput } from "@/terminal-runtime/react/use-key-events.js";
export { useRepeatingClock } from "@/terminal-runtime/react/use-repeating-clock.js";
export { useScrollbackCommit } from "@/terminal-runtime/react/use-scrollback-commit.js";
export { useTerminalDimensions } from "@/terminal-runtime/react/use-terminal-dimensions.js";
export { useVisibleRegion } from "@/terminal-runtime/react/use-visible-region.js";
export { useWindowCaption } from "@/terminal-runtime/react/use-window-caption.js";
export { oscColor, TerminalProbe } from "@/terminal-runtime/terminal/capability-probe.js";
export { detectHyperlinkCapability } from "@/terminal-runtime/terminal/link-capability.js";
export {
  OSC,
  wrapForSessionManager,
} from "@/terminal-runtime/terminal/operating-system-command.js";
export { AnsiText } from "@/terminal-runtime/text/ansi-span.js";
export {
  type ColorChannel,
  colorize,
  renderColoredText,
  renderTextWithStyles,
} from "@/terminal-runtime/text/color-codes.js";
export { default as useApp } from "./hooks/use-app.js";
