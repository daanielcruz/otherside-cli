import { dim, resolveColorSequence } from "@/terminal-runtime/text/style-helpers.js";

export {
  inputLagTraceEnabled,
  recordInputLag,
  startEventLoopMonitor,
} from "@/terminal-runtime/diagnostics/frame-latency.js";
export {
  bumpComponentRender,
  bumpRender,
  bumpRendererMs,
  bumpTranscriptMemoBreak,
  bumpTranscriptRender,
} from "@/terminal-runtime/diagnostics/render-counters.js";
export { isTerminalInteractive } from "@/terminal-runtime/host/environment.js";
export { isSessionControlMode } from "@/terminal-runtime/host/session-control-mode.js";
export {
  recoverTerminal,
  registerTerminalRecovery,
} from "@/terminal-runtime/host/terminal-restoration.js";
export type {
  KeyEventData,
  TerminalKeyState as Key,
} from "@/terminal-runtime/input/key-decoder.js";
export { ERASE_DISPLAY_TO_END } from "@/terminal-runtime/terminal/control-sequences.js";
export { canRenderGeometricShapesCleanly } from "@/terminal-runtime/terminal/glyph-support.js";
export { sgr } from "@/terminal-runtime/terminal/graphic-rendition.js";
export {
  osc8FileLink,
  osc8UrlLink,
} from "@/terminal-runtime/terminal/hyperlink-sequences.js";
export {
  evaluateLinkSupport,
  terminalAllowsLinks,
} from "@/terminal-runtime/terminal/link-policy.js";
export {
  ITERM2_COMMANDS,
  OSC,
  osc,
  oscWithStringTerminator,
  PROGRESS_STATES,
  wrapForSessionManager,
} from "@/terminal-runtime/terminal/operating-system-command.js";
export {
  emitTerminalProgress,
  isTerminalProgressSupported,
  setTerminalProgressSequenceBuilder,
  type TerminalProgressSequenceBuilder,
  type TerminalProgressState,
} from "@/terminal-runtime/terminal/progress-report.js";
export { wrapAnsi } from "@/terminal-runtime/text/ansi-wrap.js";
export {
  paintCellWidth,
  type StringWidthOptions,
  stringWidth,
} from "@/terminal-runtime/text/cell-width.js";
export {
  type ColorChannel,
  colorize,
  renderColoredText,
  renderTextWithStyles,
} from "@/terminal-runtime/text/color-codes.js";
export {
  type GraphemeChunk,
  splitByColumnWidth,
} from "@/terminal-runtime/text/column-chunks.js";
export {
  cellWidth,
  lineContainsUrlLike,
  lineHasMixedUrlAndNonUrlTokens,
  type WrapOptions,
  wrapLine,
  wrapText,
} from "@/terminal-runtime/text/plain-wrap.js";
export {
  readPresentationSequence,
  stripAnsi,
} from "@/terminal-runtime/text/presentation-sequences.js";
export type {
  TerminalColor,
  TerminalTextStyle as TextStyles,
} from "@/terminal-runtime/text/style-model.js";
export { dim, resolveColorSequence };
