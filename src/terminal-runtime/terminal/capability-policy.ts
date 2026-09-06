import { coerce } from "semver";
import { env, isEnvTruthy } from "@/kernel/std/proc/env.ts";
import { gte } from "@/kernel/std/semver.ts";
import { readAttacherCapabilities } from "@/terminal-runtime/host/environment.js";

export type RenderPhaseMetrics = {
  state: "running" | "completed" | "error" | "indeterminate";
  percentage?: number;
};

export function canReportRenderMetrics(): boolean {
  const attachedPolicy = readAttacherCapabilities()?.progressReporting;
  if (attachedPolicy !== undefined) return attachedPolicy;
  if (!process.stdout.isTTY || process.env.WT_SESSION) return false;
  if (process.env.ConEmuANSI || process.env.ConEmuPID || process.env.ConEmuTask) return true;

  const release = coerce(process.env.TERM_PROGRAM_VERSION);
  if (!release) return false;
  if (process.env.TERM_PROGRAM === "ghostty") return gte(release.version, "1.2.0");
  if (process.env.TERM_PROGRAM === "iTerm.app") return gte(release.version, "3.6.6");
  return false;
}

const SYNC_TERM_PROGRAMS = new Set([
  "iTerm.app",
  "WezTerm",
  "WarpTerminal",
  "ghostty",
  "contour",
  "vscode",
  "alacritty",
  "mintty",
  "rio",
  "Tabby",
]);

export function canUseSyncOutput(): boolean {
  if (process.env.OTHERSIDE_BACKGROUND_BACKEND === "daemon") {
    return readAttacherCapabilities()?.syncOutput !== false;
  }
  // An explicit override wins over the conservative multiplexer default:
  // modern tmux forwards synchronized-output, so a caller that knows its
  // terminal supports it can opt back in.
  if (isEnvTruthy(process.env.OTHERSIDE_FORCE_SYNC_OUTPUT)) return true;
  if (process.env.TMUX) return false;

  const program = process.env.TERM_PROGRAM;
  const termTag = process.env.TERM;
  if (program !== undefined && SYNC_TERM_PROGRAMS.has(program)) return true;
  if (process.env.TERMINAL_EMULATOR === "JetBrains-JediTerm") return true;
  if (parseInt(process.env.KONSOLE_VERSION ?? "", 10) >= 211200) return true;
  if (termTag?.includes("kitty") || process.env.KITTY_WINDOW_ID) return true;
  if (termTag === "xterm-ghostty" || termTag?.startsWith("foot")) return true;
  if (termTag?.includes("alacritty")) return true;
  if (process.env.ZED_TERM || process.env.WT_SESSION) return true;
  return parseInt(process.env.VTE_VERSION ?? "", 10) >= 6800;
}

let detectedTerminalVersion: string | undefined;

export function setDetectedTerminalVersion(name: string): void {
  detectedTerminalVersion ??= name;
}

export function readDetectedTerminalVersion(): string | undefined {
  return detectedTerminalVersion;
}

export function isWebTerminalEngine(): boolean {
  return (
    readAttacherCapabilities()?.isVscodeTerm === true ||
    process.env.TERM_PROGRAM === "vscode" ||
    (detectedTerminalVersion?.startsWith("xterm.js") ?? false)
  );
}

const ADVANCED_INPUT_TERMINALS = new Set([
  "iTerm.app",
  "kitty",
  "WezTerm",
  "ghostty",
  "tmux",
  "windows-terminal",
  "WarpTerminal",
]);

export function supportsAdvancedInput(terminal?: string | null): boolean {
  return ADVANCED_INPUT_TERMINALS.has(terminal ?? env.terminal ?? "");
}

export function hasCursorLineManipulationBug(): boolean {
  return process.platform === "win32" || Boolean(process.env.WT_SESSION);
}

export const SYNC_OUTPUT_CAPABLE = canUseSyncOutput();
