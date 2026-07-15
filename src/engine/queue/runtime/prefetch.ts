import type { UserConfig } from "@/kernel/config/config.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { autoMemDir } from "@/kernel/storage/memory/entrypoint.ts";
import { isAutoMemoryEnabled } from "@/kernel/storage/memory/session-toggle.ts";
import { createRecallState, findRelevantMemories, type RecallState } from "./select.ts";
import { formatRecallReminder, type RecalledMemory, readMemoriesForSurfacing } from "./surface.ts";

const MAX_SESSION_BYTES = 60 * 1024;
const MAX_MEMORIES_PER_TURN = 5;

const stateBySession = new Map<string, RecallState>();

function recallStateFor(sessionId: string): RecallState {
  let state = stateBySession.get(sessionId);
  if (!state) {
    state = createRecallState();
    stateBySession.set(sessionId, state);
  }
  return state;
}

export function _resetRecallStateForTesting(): void {
  stateBySession.clear();
}

// A conversation rewind removes previously injected recall reminders from
// context, so their memories must become eligible to surface again.
export function resetRecallStateForSession(sessionId: string): void {
  stateBySession.delete(sessionId);
}

export interface MemoryRecallPrefetch {
  promise: Promise<RecalledMemory[]>;
  settledAt: number | null;
  consumed: boolean;
  state: RecallState;
  abort(): void;
}

export interface MemoryRecallArgs {
  prompt: string;
  cwd: string;
  sessionId: string;
  config: UserConfig;
  makeCtx: () => RequestContext;
  parentSignal?: AbortSignal;
}

export function startMemoryRecallPrefetch(
  args: MemoryRecallArgs,
): MemoryRecallPrefetch | undefined {
  if (args.config.memoryRecall === false) return undefined;
  if (!isAutoMemoryEnabled()) return undefined;
  const input = args.prompt.trim();
  if (input.length === 0 || !/\s/.test(input)) return undefined;
  const state = recallStateFor(args.sessionId);
  if (state.surfacedBytes >= MAX_SESSION_BYTES) return undefined;

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  args.parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const promise = (async (): Promise<RecalledMemory[]> => {
    const ctx = args.makeCtx();
    const picks = await findRelevantMemories(
      input,
      autoMemDir(args.cwd),
      state,
      ctx,
      controller.signal,
    );
    const selected = picks
      .filter((p) => !state.surfacedPaths.has(p.path))
      .slice(0, MAX_MEMORIES_PER_TURN);
    return readMemoriesForSurfacing(selected, controller.signal);
  })().catch(() => [] as RecalledMemory[]);

  const handle: MemoryRecallPrefetch = {
    promise,
    settledAt: null,
    consumed: false,
    state,
    abort() {
      controller.abort();
      args.parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
  void promise.finally(() => {
    handle.settledAt = Date.now();
  });
  return handle;
}

export async function collectRecallReminders(
  handle: MemoryRecallPrefetch | undefined,
): Promise<string[]> {
  if (!handle || handle.settledAt === null || handle.consumed) return [];
  handle.consumed = true;
  const memories = await handle.promise;
  const texts: string[] = [];
  for (const memory of memories) {
    if (handle.state.surfacedPaths.has(memory.path)) continue;
    handle.state.surfacedPaths.add(memory.path);
    handle.state.surfacedBytes += memory.content.length;
    texts.push(formatRecallReminder(memory));
  }
  return texts;
}
