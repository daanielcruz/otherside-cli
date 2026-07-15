import { AsyncLocalStorage } from "node:async_hooks";

// A PreToolUse hook's parsed permissionDecision ("allow" | "ask"), threaded
// from the pipeline's hook loop through to `resolvePermission` without
// widening every call site in between (mirrors permission-abort-context.ts's
// abortSignal plumbing). `undefined` means no hook expressed an explicit
// allow/ask permissionDecision for this call (the pre-existing default path).
export type PreToolUseHookPermissionSignal = "allow" | "ask" | undefined;

const storage = new AsyncLocalStorage<PreToolUseHookPermissionSignal>();

export function preToolUseHookPermissionSignal(): PreToolUseHookPermissionSignal {
  return storage.getStore();
}

export function runWithPreToolUseHookPermissionSignal<T>(
  signal: PreToolUseHookPermissionSignal,
  fn: () => T,
): T {
  return storage.run(signal, fn);
}
