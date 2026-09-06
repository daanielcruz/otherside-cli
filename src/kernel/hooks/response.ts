import type { HookOutcome } from "./exec.ts";

// Response fields honoured for every event, alongside the event-specific fields
// each call site parses itself (decision, hookSpecificOutput, additionalContext):
//   continue: false      stops the current flow through that call site's own
//                        block/deny channel
//   suppressOutput: true keeps this hook's stdout off text surfaces
//   systemMessage        system-style text handed to the session
export interface HookResponse {
  continue?: boolean;
  suppressOutput?: boolean;
  systemMessage?: string;
}

export const HOOK_STOPPED_FLOW_REASON = "Stopped by hook";

export function jsonObjectFromStdout(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function hookResponseFromStdout(stdout: string): HookResponse {
  const parsed = jsonObjectFromStdout(stdout);
  if (!parsed) return {};
  const out: HookResponse = {};
  if (typeof parsed.continue === "boolean") out.continue = parsed.continue;
  if (typeof parsed.suppressOutput === "boolean") out.suppressOutput = parsed.suppressOutput;
  if (typeof parsed.systemMessage === "string" && parsed.systemMessage.trim().length > 0) {
    out.systemMessage = parsed.systemMessage;
  }
  return out;
}

export function hookStopsFlow(stdout: string): boolean {
  return hookResponseFromStdout(stdout).continue === false;
}

export function hookStopReason(stdout: string): string {
  return hookResponseFromStdout(stdout).systemMessage ?? HOOK_STOPPED_FLOW_REASON;
}

export function systemMessageFromStdout(stdout: string): string | null {
  return hookResponseFromStdout(stdout).systemMessage ?? null;
}

export function systemMessagesFromOutcomes(outcomes: readonly HookOutcome[]): string[] {
  const out: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind !== "ok") continue;
    const message = systemMessageFromStdout(outcome.stdout);
    if (message) out.push(message);
  }
  return out;
}

export function isOutputSuppressed(stdout: string): boolean {
  return hookResponseFromStdout(stdout).suppressOutput === true;
}

/**
 * Text a hook contributed to a user/model-visible surface: stderr always,
 * stdout only when the hook did not set suppressOutput.
 */
export function hookOutcomeText(outcome: { stdout: string; stderr: string }): string {
  const stderr = outcome.stderr.trim();
  if (stderr.length > 0) return stderr;
  return isOutputSuppressed(outcome.stdout) ? "" : outcome.stdout.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
