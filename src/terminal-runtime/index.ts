export { default as render } from "@/terminal-runtime/host/mount-runtime.js";

import inkInstances from "@/terminal-runtime/host/runtime-registry.js";
import { dim, resolveColorSequence } from "@/terminal-runtime/text/style-helpers.js";

export { dim, resolveColorSequence };

export function discardFrameBaseline(stdout: NodeJS.WriteStream = process.stdout): void {
  inkInstances.get(stdout)?.invalidatePrevFrame();
}

export {
  inputLagTraceEnabled,
  recordInputLag,
  startEventLoopMonitor,
} from "@/devtools/render/instrumentation.ts";
// Barrel additions for former deep @/terminal-runtime consumers (outside the module).
export { default as Ink } from "@/terminal-runtime/host/runtime-session.js";
export type {
  KeyStroke,
  TerminalKey as Key,
} from "@/terminal-runtime/input/input-signal.js";
export { subscribeTerminalThemeNotify } from "@/terminal-runtime/input/key-decoder.js";
export { cellAtIndex, type Screen } from "@/terminal-runtime/paint/cell-grid.js";
export type { FrameMetrics } from "@/terminal-runtime/paint/frame-state.js";
export { paintToTerminal } from "@/terminal-runtime/paint/screen-diff.js";
export type {
  TerminalColor as Color,
  TerminalTextStyle as TextStyles,
} from "@/terminal-runtime/paint/style-model.js";
export { useIsScreenReaderEnabled } from "@/terminal-runtime/react/accessibility-state.js";
export { TerminalSizeContext } from "@/terminal-runtime/react/dimensions-context.js";
export { default as Box } from "@/terminal-runtime/react/flex-container.js";
export { RawSequence } from "@/terminal-runtime/react/raw-sequence.js";
export { default as StaticFlushContext } from "@/terminal-runtime/react/scrollback-context.js";
export { default as Text } from "@/terminal-runtime/react/styled-text.js";
export { default as TerminalLink } from "@/terminal-runtime/react/terminal-link.js";
export { TimekeeperContext } from "@/terminal-runtime/react/time-source.js";
export { default as useApp } from "@/terminal-runtime/react/use-app.js";
export { useCursorOwner } from "@/terminal-runtime/react/use-cursor-owner.js";
export { useIsTerminalFocused } from "@/terminal-runtime/react/use-focus-state.js";
export { useFrameClock } from "@/terminal-runtime/react/use-frame-clock.js";
export { default as useStdin } from "@/terminal-runtime/react/use-input-stream.js";
export { default as useInput } from "@/terminal-runtime/react/use-key-events.js";
export { usePaste } from "@/terminal-runtime/react/use-paste.ts";
export { useRepeatingClock } from "@/terminal-runtime/react/use-repeating-clock.js";
export { useScrollbackCommit } from "@/terminal-runtime/react/use-scrollback-commit.js";
export { useStdout } from "@/terminal-runtime/react/use-stdout.ts";
export { useTerminalDimensions } from "@/terminal-runtime/react/use-terminal-dimensions.js";
export { useVisibleRegion } from "@/terminal-runtime/react/use-visible-region.js";
export { useWindowCaption } from "@/terminal-runtime/react/use-window-caption.js";
export { oscColor, TerminalProbe } from "@/terminal-runtime/terminal/capability-probe.js";
export { detectHyperlinkCapability } from "@/terminal-runtime/terminal/link-capability.js";
export {
  ITERM2_COMMANDS,
  OSC,
  osc,
  PROGRESS_STATES,
  wrapForSessionManager,
} from "@/terminal-runtime/terminal/operating-system-command.js";
export { AnsiText } from "@/terminal-runtime/text/ansi-span.js";
export { wrapAnsi } from "@/terminal-runtime/text/ansi-wrap.js";
export {
  type ColorChannel,
  colorize,
  renderColoredText,
  renderTextWithStyles,
} from "@/terminal-runtime/text/color-codes.js";
export { default as reactAdapter } from "@/terminal-runtime/tree/react-adapter.js";
