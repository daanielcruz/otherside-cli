import {
  formatWorkflowError,
  wrapSyncForVm,
} from "@/engine/background/workflows/runtime/sandbox/errors.ts";

export interface WorkflowAbortableTimers {
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  bindVMInvoke: (invoke: (callback: () => void) => void) => void;
}

export function createAbortableTimers(
  signal?: AbortSignal,
  onCallbackError?: (message: string) => void,
): WorkflowAbortableTimers {
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  let sequence = 0;
  let invoke = (callback: () => void): void => callback();
  const clearAll = (): void => {
    for (const handle of handles.values()) clearTimeout(handle);
    handles.clear();
  };
  signal?.addEventListener("abort", clearAll, { once: true });
  return {
    setTimeout: wrapSyncForVm((callback: () => void, ms: number): number => {
      if (signal?.aborted) return 0;
      const id = sequence + 1;
      sequence = id;
      const handle = setTimeout(() => {
        handles.delete(id);
        // A throwing timer callback would otherwise reach the host event
        // loop as an unhandled exception; the workflow only ever observes
        // it as a no-op, same as any other host-boundary hook failure.
        try {
          invoke(callback);
        } catch (error) {
          onCallbackError?.(`setTimeout callback threw: ${formatWorkflowError(error)}`);
        }
      }, ms);
      handles.set(id, handle);
      return id;
    }),
    clearTimeout: wrapSyncForVm((id: number): void => {
      const handle = handles.get(id);
      if (!handle) return;
      handles.delete(id);
      clearTimeout(handle);
    }),
    bindVMInvoke(next: (callback: () => void) => void): void {
      invoke = next;
    },
  };
}
