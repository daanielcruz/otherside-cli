import { fireEntry, type HookOutcome } from "@/kernel/hooks/exec.ts";
import { hookStopReason, hookStopsFlow, jsonObjectFromStdout } from "@/kernel/hooks/response.ts";
import type { CommandHookEntry } from "@/kernel/std/types/hook-entry.ts";

// Synchronous command Stop hooks run to completion at turn end and their
// verdict gates whether the turn may stop:
// - exit 0 with no JSON decision (or decision "approve") allows the stop;
// - exit 0 with stdout JSON `{"decision":"block","reason":...}` blocks with
//   the reason (default "Blocked by hook");
// - exit 0 with stdout JSON `{"continue":false}` blocks the same way, using
//   `systemMessage` as the feedback when present;
// - exit 2 blocks with `[<command>]: <stderr or "No stderr output">` — the
//   stderr body is passed through unmodified (trailing newlines included);
// - any other exit, a timeout, or a spawn failure is a non-blocking failure
//   surfaced to the user without holding the turn open.
// A blocking verdict is fed back to the model as a user message
// (`Stop hook feedback:\n<feedback>`), so the loop runs another round before
// the turn can end. Async-flagged entries never reach this path — see
// stop-hook-rewake.ts.

export type SyncStopHookVerdict =
  | { kind: "allow" }
  | { kind: "block"; feedback: string }
  | { kind: "failed"; message: string };

export async function runSyncStopHook(
  entry: CommandHookEntry,
  sessionId: string,
  stopHookActive = false,
): Promise<SyncStopHookVerdict> {
  const outcome = await fireEntry(entry, { kind: "stop", ctx: { sessionId, stopHookActive } });
  return syncStopHookVerdict(entry, outcome);
}

export function syncStopHookVerdict(
  entry: CommandHookEntry,
  outcome: HookOutcome,
): SyncStopHookVerdict {
  switch (outcome.kind) {
    case "ok":
      return verdictFromStdout(outcome.stdout);
    case "non_zero_exit":
      if (outcome.code === 2) {
        return {
          kind: "block",
          feedback: `[${entry.command}]: ${outcome.stderr || "No stderr output"}`,
        };
      }
      return {
        kind: "failed",
        message: `command "${entry.command}" exited with code ${outcome.code}: ${
          outcome.stderr.trim() || "no stderr output"
        }`,
      };
    case "timeout":
      return { kind: "failed", message: `command "${entry.command}" timed out` };
    case "spawn_failed":
      return {
        kind: "failed",
        message: `command "${entry.command}" failed to start: ${outcome.error}`,
      };
    case "prompt_blocked":
      return { kind: "block", feedback: outcome.reason };
    default:
      // Prompt outcomes never reach the command path.
      return { kind: "allow" };
  }
}

function verdictFromStdout(stdout: string): SyncStopHookVerdict {
  if (hookStopsFlow(stdout)) return { kind: "block", feedback: hookStopReason(stdout) };
  const parsed = jsonObjectFromStdout(stdout);
  if (!parsed) return { kind: "allow" };
  if (parsed.decision !== "block") return { kind: "allow" };
  const reason =
    typeof parsed.reason === "string" && parsed.reason.length > 0 ? parsed.reason : null;
  return { kind: "block", feedback: reason ?? "Blocked by hook" };
}
