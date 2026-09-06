import type { HookEntry } from "@/kernel/std/types/hook-entry.ts";
import type { HookEvent } from "./events.ts";

// Hook definitions declare `timeout` in SECONDS. Absent or unusable values fall
// back to the per-event default: tool lifecycle hooks get the
// long budget because they gate a tool call that may legitimately take minutes,
// every other event gets the short one.
export const TOOL_HOOK_TIMEOUT_SECONDS = 600;
export const HOOK_TIMEOUT_SECONDS = 60;

export function defaultHookTimeoutSeconds(event: HookEvent): number {
  return event === "preToolUse" ||
    event === "postToolUse" ||
    event === "postToolUseFailure" ||
    event === "postToolBatch" ||
    event === "permissionRequest"
    ? TOOL_HOOK_TIMEOUT_SECONDS
    : HOOK_TIMEOUT_SECONDS;
}

export function hookTimeoutSeconds(entry: HookEntry, event: HookEvent): number {
  const declared = entry.timeout;
  if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) return declared;
  return defaultHookTimeoutSeconds(event);
}

export function hookTimeoutMs(entry: HookEntry, event: HookEvent): number {
  return Math.max(1, Math.round(hookTimeoutSeconds(entry, event) * 1000));
}
