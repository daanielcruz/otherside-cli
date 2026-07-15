import { AsyncLocalStorage } from "node:async_hooks";

const permissionAbortSignalStorage = new AsyncLocalStorage<AbortSignal | undefined>();

export function permissionAbortSignal(): AbortSignal | undefined {
  return permissionAbortSignalStorage.getStore();
}

export function runWithPermissionAbortSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return permissionAbortSignalStorage.run(signal, fn);
}
