import { escapeXml } from "@/engine/background/tasks/notification.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { fireEntry, type HookOutcome } from "@/kernel/hooks/exec.ts";
import { hookOutcomeText } from "@/kernel/hooks/response.ts";
import type { CommandHookEntry } from "@/kernel/std/types/hook-entry.ts";

// Async Stop-hook rewake: a Stop hook flagged `async` or `asyncRewake` is launched in
// the background at turn end instead of blocking it. When an `asyncRewake`
// hook later exits with code 2, a task-notification is enqueued so the next
// turn (an idle session auto-wakes via autoTurn) receives the hook's feedback.
//
// Gates:
// - `async` backgrounds the hook unconditionally (fire-and-forget; no rewake).
// - `asyncRewake` backgrounds AND rewakes, but only on an interactive session.
// - `forceSyncExecution` (internal callers) suppresses both (`&& !d`).
// - Rewake fires ONLY on exit code 2 (`f.code === 2`) — the Stop-hook blocking
//   convention; any other exit is silent.
// - `rewakeMessage` overrides the body prefix; `rewakeSummary` overrides the
//   <summary> text (default "Stop hook feedback") and is used verbatim — only
//   the plugin-stdout summary source (mEo gate, not ported: our plugin hooks
//   carry no versioned id) is length-capped there.
// - The queued value is the notification XML followed by the prefixed
//   stderr-or-stdout body, priority "next" ≈ urgent_output here.
// - The item is flagged `stopHookActive`: the turn that consumes it runs its
//   own Stop hooks with STOP_HOOK_ACTIVE set so a hook script can detect the
//   rewake continuation and break the loop.

export const ASYNC_REWAKE_FLUSH_TIMEOUT_MS = 30_000;

// The Stop hooks of the turn currently running were triggered by a rewake
// notification consumed at that turn's start. Set by the turn loop when the
// turn-start drain carries the flag; cleared when the turn ends.
let stopHookActiveTurn = false;

export function setStopHookActiveTurn(active: boolean): void {
  stopHookActiveTurn = active;
}

export function isStopHookActiveTurn(): boolean {
  return stopHookActiveTurn;
}

const pendingAsyncStopHooks = new Set<Promise<void>>();

export interface AsyncStopHookGateInput {
  entry: CommandHookEntry;
  interactive: boolean;
  forceSyncExecution?: boolean;
  sessionId: string;
  /** The stopping turn was itself started by a rewake notification. */
  stopHookActive?: boolean;
}

export function isAsyncStopHook(input: AsyncStopHookGateInput): boolean {
  if (input.forceSyncExecution === true) return false;
  const entry = input.entry;
  if (entry.async === true) return true;
  return entry.asyncRewake === true && input.interactive;
}

export function buildStopHookRewakeNotification(
  entry: CommandHookEntry,
  outcome: HookOutcome & { kind: "non_zero_exit" },
): { text: string; summary: string } {
  const summary = entry.rewakeSummary?.trim() || "Stop hook feedback";
  const prefix = entry.rewakeMessage ?? 'Stop hook blocking error from command "Stop":';
  const body = hookOutcomeText(outcome);
  const text = `<task-notification>\n<summary>${escapeXml(summary)}</summary>\n</task-notification>\n${prefix} ${body}`;
  return { text, summary };
}

/**
 * Launches an async Stop hook in the background. Returns true when the entry
 * was taken async (the caller must NOT run it synchronously), false when the
 * gates say it is not an async hook.
 */
export function launchAsyncStopHook(input: AsyncStopHookGateInput): boolean {
  if (!isAsyncStopHook(input)) return false;
  const entry = input.entry;
  const rewakeEligible = entry.asyncRewake === true && input.interactive;
  const run = (async (): Promise<void> => {
    let outcome: HookOutcome;
    try {
      outcome = await fireEntry(entry, {
        kind: "stop",
        ctx: { sessionId: input.sessionId, stopHookActive: input.stopHookActive === true },
      });
    } catch {
      return;
    }
    if (!rewakeEligible) return;
    if (outcome.kind !== "non_zero_exit" || outcome.code !== 2) return;
    const { text, summary } = buildStopHookRewakeNotification(entry, outcome);
    emitQueue.emit({
      class: "urgent_output",
      target: "both",
      payload: { kind: "task_notification_xml", text, summary },
      autoTurn: true,
      stopHookActive: true,
    });
  })();
  pendingAsyncStopHooks.add(run);
  void run.finally(() => pendingAsyncStopHooks.delete(run));
  return true;
}

/**
 * Waits (bounded) for in-flight async Stop hooks so a session shutdown does
 * not orphan a rewake mid-write.
 */
export async function drainPendingAsyncRewakeHooks(): Promise<void> {
  if (pendingAsyncStopHooks.size === 0) return;
  const settled = Promise.allSettled([...pendingAsyncStopHooks]);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ASYNC_REWAKE_FLUSH_TIMEOUT_MS);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  });
  await Promise.race([settled, timeout]);
  if (timer !== null) clearTimeout(timer);
}

export function _resetAsyncStopHooksForTests(): void {
  pendingAsyncStopHooks.clear();
  stopHookActiveTurn = false;
}
