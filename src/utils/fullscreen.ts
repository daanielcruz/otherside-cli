import { spawnSync } from "node:child_process";
import { isTerminalInteractive } from "@/bootstrap/state.ts";
import { emitDiagnosticOutput } from "@/devtools/output.ts";
import { isEnvDefinedFalsy, isEnvTruthy } from "@/kernel/std/env.ts";
import { runProcessSafely } from "@/utils/execFileNoThrow.ts";

let hasLoggedSessionModeSuppression = false;
let hasCheckedScrollingGuidance = false;

let sessionModeProbeResult: boolean | undefined;

function detectSessionModeFromEnv(): boolean {
  if (!process.env.TMUX) return false;
  if (process.env.TERM_PROGRAM !== "iTerm.app") return false;

  const term = process.env.TERM ?? "";
  return !term.startsWith("screen") && !term.startsWith("tmux");
}

function probeSessionModeSync(): void {
  sessionModeProbeResult = detectSessionModeFromEnv();
  if (sessionModeProbeResult) return;
  if (!process.env.TMUX) return;

  if (process.env.TERM_PROGRAM) return;
  let result;
  try {
    result = spawnSync("tmux", ["display-message", "-p", "#{client_control_mode}"], {
      encoding: "utf8",
      timeout: 2000,
    });
  } catch {
    return;
  }

  if (result.status !== 0) return;
  sessionModeProbeResult = result.stdout.trim() === "1";
}

export function isSessionModeActive(): boolean {
  if (sessionModeProbeResult === undefined) probeSessionModeSync();
  return sessionModeProbeResult ?? false;
}

export function _resetSessionModeProbeForTesting(): void {
  sessionModeProbeResult = undefined;
  hasLoggedSessionModeSuppression = false;
}

export function isAlternateBufferEnvEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.OTHERSIDE_NO_FLICKER)) return false;

  if (isEnvTruthy(process.env.OTHERSIDE_NO_FLICKER)) return true;

  if (isSessionModeActive()) {
    if (!hasLoggedSessionModeSuppression) {
      hasLoggedSessionModeSuppression = true;
      emitDiagnosticOutput(
        "fullscreen disabled: tmux -CC (iTerm2 integration mode) detected · set OTHERSIDE_NO_FLICKER=1 to override",
      );
    }
    return false;
  }
  return false;
}

export function isPointerTrackingEnabled(): boolean {
  return !isEnvTruthy(process.env.OTHERSIDE_DISABLE_MOUSE);
}

export function arePointerClicksDisabled(): boolean {
  return isEnvTruthy(process.env.OTHERSIDE_DISABLE_MOUSE_CLICKS);
}

export function isAlternateBufferActive(): boolean {
  return isTerminalInteractive() && isAlternateBufferEnvEnabled();
}

export async function maybeGetScrollingGuidance(): Promise<string | null> {
  if (!process.env.TMUX) return null;

  if (!isAlternateBufferActive() || isSessionModeActive()) return null;
  if (hasCheckedScrollingGuidance) return null;
  hasCheckedScrollingGuidance = true;

  const { stdout, code } = await runProcessSafely("tmux", ["show", "-Av", "mouse"], {
    useCwd: false,
    timeout: 2000,
  });
  if (code !== 0 || stdout.trim() === "on") return null;
  return "tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on' to ~/.tmux.conf for wheel scroll";
}

export function _resetFullscreenStateForTesting(): void {
  hasLoggedSessionModeSuppression = false;
  hasCheckedScrollingGuidance = false;
}
