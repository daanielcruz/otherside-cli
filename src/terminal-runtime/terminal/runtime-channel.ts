import type { Writable } from "node:stream";
import { coerce } from "semver";
import { getAttacherCaps } from "@/bootstrap/state.js";
import type { Diff } from "@/terminal-runtime/paint/frame-state.js";
import { eraseViewportInPlace } from "@/terminal-runtime/terminal/clear-screen.js";
import { cursorMove, cursorTo, eraseLines } from "@/terminal-runtime/terminal/control-sequences.js";
import { link } from "@/terminal-runtime/terminal/operating-system-command.js";
import {
  BSU,
  CURSOR_DISPLAY_OFF,
  CURSOR_DISPLAY_ON,
  ESU,
} from "@/terminal-runtime/terminal/private-modes.js";
import { emitDiagnosticOutput } from "@/utils/debug.js";
import { env, isTreatedAsTrue } from "@/utils/env.js";
import { gte } from "@/utils/semver.js";
import { terminalDetector } from "@/utils/terminalDetector.js";

export type RenderPhaseMetrics = {
  state: "running" | "completed" | "error" | "indeterminate";
  percentage?: number;
};

export function canReportRenderMetrics(): boolean {
  const caps = getAttacherCaps();
  if (caps?.progressReporting !== undefined) {
    return caps.progressReporting;
  }

  if (!process.stdout.isTTY) {
    return false;
  }

  if (process.env.WT_SESSION) {
    return false;
  }

  if (process.env.ConEmuANSI || process.env.ConEmuPID || process.env.ConEmuTask) {
    return true;
  }

  const version = coerce(process.env.TERM_PROGRAM_VERSION);
  if (!version) {
    return false;
  }

  if (process.env.TERM_PROGRAM === "ghostty") {
    return gte(version.version, "1.2.0");
  }

  if (process.env.TERM_PROGRAM === "iTerm.app") {
    return gte(version.version, "3.6.6");
  }

  return false;
}

export function canUseSyncOutput(): boolean {
  if (process.env.OTHERSIDE_BACKGROUND_BACKEND === "daemon") {
    return getAttacherCaps()?.syncOutput !== false;
  }

  if (process.env.TMUX) return false;

  if (isTreatedAsTrue(process.env.OTHERSIDE_FORCE_SYNC_OUTPUT)) {
    return true;
  }

  const termProgram = process.env.TERM_PROGRAM;
  const term = process.env.TERM;

  if (
    termProgram === "iTerm.app" ||
    termProgram === "WezTerm" ||
    termProgram === "WarpTerminal" ||
    termProgram === "ghostty" ||
    termProgram === "contour" ||
    termProgram === "vscode" ||
    termProgram === "alacritty" ||
    termProgram === "mintty" ||
    termProgram === "rio" ||
    termProgram === "Tabby"
  ) {
    return true;
  }

  if (terminalDetector.isJetBrainsIdeTerminal()) return true;

  if (parseInt(process.env.KONSOLE_VERSION ?? "", 10) >= 211200) return true;

  if (term?.includes("kitty") || process.env.KITTY_WINDOW_ID) return true;

  if (term === "xterm-ghostty") return true;

  if (term?.startsWith("foot")) return true;

  if (term?.includes("alacritty")) return true;

  if (process.env.ZED_TERM) return true;

  if (process.env.WT_SESSION) return true;

  const vteVersion = process.env.VTE_VERSION;
  if (vteVersion) {
    const version = parseInt(vteVersion, 10);
    if (version >= 6800) return true;
  }

  return false;
}

let detectedTerminalVersion: string | undefined;

export function setDetectedTerminalVersion(name: string): void {
  if (detectedTerminalVersion === undefined) detectedTerminalVersion = name;
}

export function getXtversionName(): string | undefined {
  return detectedTerminalVersion;
}

export function isWebTerminalEngine(): boolean {
  if (getAttacherCaps()?.isVscodeTerm) return true;
  if (process.env.TERM_PROGRAM === "vscode") return true;
  return detectedTerminalVersion?.startsWith("xterm.js") ?? false;
}

const ADVANCED_INPUT_TERMINALS = [
  "iTerm.app",
  "kitty",
  "WezTerm",
  "ghostty",
  "tmux",
  "windows-terminal",
  "WarpTerminal",
];

export function supportsAdvancedInput(terminal?: string | null): boolean {
  return ADVANCED_INPUT_TERMINALS.includes(terminal ?? env.terminal ?? "");
}

export function hasCursorLineManipulationBug(): boolean {
  return process.platform === "win32" || !!process.env.WT_SESSION;
}

export const SYNC_OUTPUT_CAPABLE = canUseSyncOutput();

export type Terminal = {
  stdout: Writable;
  stderr: Writable;
};

let writeErrored = false;
let isDaemonMode: boolean | undefined;
const WRITE_CHUNK_BYTES = 64 * 1024;

function isDaemon(): boolean {
  if (isDaemonMode === undefined) {
    isDaemonMode = process.env.OTHERSIDE_BACKGROUND_BACKEND === "daemon";
  }
  return isDaemonMode;
}

function getErrorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? String((err as any).code) : undefined;
}

export function flushDiffBuffer(
  terminal: Terminal,
  diff: Diff,
  skipSyncMarkers = false,
  maxCursorMoveY?: number,
): void {
  if (writeErrored) {
    return;
  }

  if (diff.length === 0) {
    return;
  }

  const useSync = !skipSyncMarkers;

  let buffer = useSync ? BSU : "";

  const write = (chunk: string): boolean => {
    try {
      terminal.stdout.write(chunk);
      return true;
    } catch (err) {
      if (isDaemon() && (getErrorCode(err) === "EIO" || getErrorCode(err) === "EPIPE")) {
        writeErrored = true;
        return false;
      }
      throw err;
    }
  };
  const append = (content: string): boolean => {
    if (content.length === 0) return true;
    if (buffer.length > 0 && buffer.length + content.length > WRITE_CHUNK_BYTES) {
      if (!write(buffer)) return false;
      buffer = "";
    }
    if (content.length <= WRITE_CHUNK_BYTES) {
      buffer += content;
      return true;
    }
    for (let start = 0; start < content.length; start += WRITE_CHUNK_BYTES) {
      if (!write(content.slice(start, start + WRITE_CHUNK_BYTES))) return false;
    }
    return true;
  };

  const boundY =
    maxCursorMoveY !== undefined && maxCursorMoveY > 1 ? maxCursorMoveY - 1 : undefined;

  for (const patch of diff) {
    let content = "";
    switch (patch.type) {
      case "stdout":
        content = patch.content;
        break;
      case "clear":
        if (patch.count > 0) content = eraseLines(patch.count);
        break;
      case "clearTerminal":
        content = eraseViewportInPlace(patch.viewportRows);
        break;
      case "cursorHide":
        content = CURSOR_DISPLAY_OFF;
        break;
      case "cursorShow":
        content = CURSOR_DISPLAY_ON;
        break;
      case "cursorMove": {
        const clampedY =
          boundY !== undefined ? Math.max(-boundY, Math.min(boundY, patch.y)) : patch.y;
        if (clampedY !== patch.y) {
          emitDiagnosticOutput(`[CLAMP] cursorMove dy=${patch.y} clamped=${clampedY}`);
        }
        content = cursorMove(patch.x, clampedY);
        break;
      }
      case "cursorTo":
        content = cursorTo(patch.col);
        break;
      case "carriageReturn":
        content = "\r";
        break;
      case "hyperlink":
        content = link(patch.uri);
        break;
      case "styleStr":
        content = patch.str;
        break;
    }
    if (!append(content)) return;
  }

  if (useSync && !append(ESU)) return;
  if (buffer.length > 0) write(buffer);
}
