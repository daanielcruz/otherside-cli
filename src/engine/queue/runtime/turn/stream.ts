import { listEnabledHookEntries } from "@/engine/plugins/registry.ts";
import { QuotaExhaustedError } from "@/engine/providers/_shared/retry.ts";
import * as providers from "@/engine/providers/registry.ts";
import { sessionGitStatus } from "@/engine/queue/runtime/git-status.ts";
import { runPromptClassifier } from "@/engine/queue/runtime/goal-evaluation.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import type { StopConditionVerdict } from "@/engine/queue/runtime/stop-hook-classifier.ts";
import {
  isStopHookActiveTurn,
  launchAsyncStopHook,
} from "@/engine/queue/runtime/stop-hook-rewake.ts";
import {
  runSyncStopHook,
  type SyncStopHookVerdict,
} from "@/engine/queue/runtime/stop-hook-sync.ts";
import { currentLocalISODate } from "@/engine/queue/runtime/turn-prompts.ts";
import { appendRecord } from "@/engine/session/persist.ts";
import { nowIso } from "@/engine/session/record/index.ts";
import { shrinkToolResultRecord } from "@/engine/session/state.ts";
import {
  appendTaskReminderMessage,
  buildTaskReminderInjection,
} from "@/engine/session/task-reminder.ts";
import {
  applyToolOutputBudget,
  createToolOutputArchive,
} from "@/engine/tool-output-archive/index.ts";
import { providerToolDeclarations, runRound } from "@/engine/translator/index.ts";
import type { InjectionQueue } from "@/harness/composer/injections.ts";
import { fireEntry } from "@/kernel/hooks/exec.ts";
import { fireConfiguredHooks } from "@/kernel/hooks/handler.ts";
import { loadRulesSync } from "@/kernel/permissions/persist.ts";
import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import type { AgentEvent, ProviderEvent } from "@/kernel/std/types/events.ts";
import { collectMemoryFiles } from "@/kernel/storage/memory/loader.ts";
import type { AgentDeps, TurnLoopHost } from "./types.ts";

const instructionHookPaths = new WeakMap<object, Set<string>>();

export interface TurnStreamDeps {
  agentDeps: AgentDeps;
  injections: InjectionQueue;
  nestedMemorySnapshot(): { path: string; content: string }[];
  cancelled(): boolean;
  turnId?: string;
}

export function turnStreamDeps(host: TurnLoopHost): TurnStreamDeps {
  return {
    agentDeps: host.deps,
    injections: host.injections,
    nestedMemorySnapshot: () => host.getNestedMemorySnapshot(),
    cancelled: () => host.cancelled,
    ...(host.currentTurnId !== null ? { turnId: host.currentTurnId } : {}),
  };
}

async function fireNewInstructionHooks(deps: AgentDeps): Promise<void> {
  let loaded = instructionHookPaths.get(deps.session);
  if (!loaded) {
    loaded = new Set();
    instructionHookPaths.set(deps.session, loaded);
  }
  for (const file of collectMemoryFiles(deps.session.cwd)) {
    if ((file.scope !== "user" && file.scope !== "project") || loaded.has(file.path)) continue;
    loaded.add(file.path);
    await fireConfiguredHooks(deps.config, "instructionsLoaded", {
      kind: "instructionsLoaded",
      ctx: {
        filePath: file.path,
        memoryType: file.scope === "user" ? "User" : "Project",
        loadReason: "session_start",
        sessionId: deps.session.id,
        cwd: deps.session.cwd,
      },
    });
  }
}

export async function* openProviderStream(
  deps: TurnStreamDeps,
  abortSignal?: AbortSignal,
): AsyncIterable<ProviderEvent> {
  const ctx = makeRequestContext(deps.agentDeps, deps.turnId);
  if (abortSignal) ctx.abortSignal = abortSignal;
  await fireNewInstructionHooks(deps.agentDeps);
  const provider = providers.get(ctx.provider);
  if (!deps.agentDeps.session.toolOutputArchive) {
    deps.agentDeps.session.toolOutputArchive = createToolOutputArchive();
  }
  const budgetMessages = await applyToolOutputBudget(
    deps.agentDeps.session.messages,
    deps.agentDeps.session.toolOutputArchive,
    (records) => {
      for (const record of records) {
        shrinkToolResultRecord(deps.agentDeps.session, record.toolUseId, record.replacement);
        appendRecord(deps.agentDeps.session, {
          type: "content_replacement",
          ts: nowIso(),
          kind: record.kind,
          toolUseId: record.toolUseId,
          replacement: record.replacement,
        }).catch(() => {});
      }
    },
  );
  deps.agentDeps.session.messages.splice(
    0,
    deps.agentDeps.session.messages.length,
    ...budgetMessages,
  );
  // Persist the task-tools reminder into the live history (once per round, before
  // assembly) rather than appending it to a throwaway compose copy. Because it now
  // lives in session.messages, it survives to the next round: the history-scanning
  // throttle keeps it from re-firing, and the trailing cache breakpoint stays
  // anchored on stable content instead of a reminder that vanished.
  const effectiveTools = providerToolDeclarations(provider, deps.agentDeps.config, {
    model: ctx.model,
    mainAgent: ctx.agentOwnerId === undefined && ctx.isForkChild !== true,
    permissionRules: loadRulesSync(ctx.cwd),
    ...(ctx.orchestrationMode !== undefined ? { orchestrationMode: ctx.orchestrationMode } : {}),
  });
  const taskReminder = buildTaskReminderInjection({
    messages: deps.agentDeps.session.messages,
    effectiveTools,
  });
  if (taskReminder !== null) {
    appendTaskReminderMessage(deps.agentDeps.session.messages, taskReminder);
  }
  const gitStatus = await sessionGitStatus();
  // Stamp each attempt's message_start with the route that opened it: a
  // mid-stream route switch must not reclassify bytes this attempt produces.
  for await (const event of runRound({
    ctx,
    provider,
    assemble: {
      messages: deps.agentDeps.session.messages,
      injections: deps.injections,
      config: deps.agentDeps.config,
      currentDate: currentLocalISODate(),
      nestedMemory: deps.nestedMemorySnapshot(),
      ...(gitStatus !== null ? { gitStatus } : {}),
    },
    persistAssembledTurn: true,
  })) {
    yield event.kind === "message_start"
      ? { ...event, provider: ctx.provider, model: ctx.model }
      : event;
  }
}

export async function* fireStopPromptHooks(
  deps: TurnStreamDeps,
  abortSignal?: AbortSignal,
): AsyncGenerator<AgentEvent, boolean> {
  const entries = [...(deps.agentDeps.config.hooks?.stop ?? []), ...listEnabledHookEntries("stop")];
  if (entries.length === 0) return false;
  let blocked = false;
  const stopHookActive = isStopHookActiveTurn();
  for (const entry of entries) {
    // Command-type Stop hooks flagged async/asyncRewake launch in the
    // background at turn end — never blocking it. An asyncRewake hook that
    // later exits 2 enqueues a rewake task-notification (stop-hook-rewake.ts).
    // A plain command hook runs synchronously: exit 2 blocks the stop and
    // feeds its stderr back to the model; other exits are silent.
    if (entry.type === undefined || entry.type === "command") {
      const takenAsync = launchAsyncStopHook({
        entry,
        interactive: getRuntimeKind() !== "print",
        sessionId: deps.agentDeps.session.id,
        stopHookActive,
      });
      if (takenAsync) continue;
      if (deps.cancelled() || abortSignal?.aborted) return blocked;
      let verdict: SyncStopHookVerdict;
      try {
        verdict = await runSyncStopHook(entry, deps.agentDeps.session.id, stopHookActive);
      } catch (err) {
        yield {
          kind: "error",
          error: `stop-hook command error: ${err instanceof Error ? err.message : String(err)}`,
        };
        continue;
      }
      if (verdict.kind === "failed") {
        yield { kind: "error", error: `stop hook failed: ${verdict.message}` };
        continue;
      }
      if (verdict.kind !== "block") continue;
      blocked = true;
      deps.agentDeps.session.messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Stop hook feedback:\n${verdict.feedback}`,
          },
        ],
      });
      yield { kind: "error", error: `stop hook blocked: ${verdict.feedback}` };
      continue;
    }
    if (entry.type === "agent" || entry.type === "http") {
      if (deps.cancelled() || abortSignal?.aborted) return blocked;
      const outcome = await fireEntry(entry, {
        kind: "stop",
        ctx: { sessionId: deps.agentDeps.session.id, stopHookActive },
      });
      if (outcome.kind !== "prompt_blocked") continue;
      blocked = true;
      deps.agentDeps.session.messages.push({
        role: "user",
        content: [{ type: "text", text: `Stop hook feedback:\n${outcome.reason}` }],
      });
      yield { kind: "error", error: `stop hook blocked: ${outcome.reason}` };
      continue;
    }
    if (entry.type !== "prompt") continue;
    if (deps.cancelled() || abortSignal?.aborted) return blocked;
    let verdict: StopConditionVerdict;
    try {
      verdict = await runPromptClassifier(
        {
          session: deps.agentDeps.session,
          config: deps.agentDeps.config,
          ctx: makeRequestContext(deps.agentDeps, deps.turnId),
          cancelled: deps.cancelled,
          ...(abortSignal ? { abortSignal } : {}),
        },
        entry.prompt,
      );
    } catch (err) {
      if (deps.cancelled() || abortSignal?.aborted) return blocked;
      if (err instanceof QuotaExhaustedError) {
        yield {
          kind: "quota_exhausted",
          provider: err.provider,
          model: err.model,
          resetEpochMs: err.resetEpochMs,
          message: err.message,
        };
        return blocked;
      }
      yield {
        kind: "error",
        error: `stop-hook prompt error: ${err instanceof Error ? err.message : String(err)}`,
      };
      continue;
    }
    if (verdict.ok || verdict.impossible === true) continue;
    blocked = true;
    const reason = verdict.reason;
    deps.agentDeps.session.messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `Stop hook feedback:\n[${entry.prompt}]: ${reason}`,
        },
      ],
    });
    yield { kind: "error", error: `stop hook blocked: ${reason}` };
  }
  return blocked;
}

export interface AssistantUsageSnap {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function mergeUsageSnap(
  prev: AssistantUsageSnap | null,
  ev: ProviderEvent & { kind: "usage" },
): AssistantUsageSnap {
  return {
    inputTokens: ev.inputTokens ?? prev?.inputTokens ?? 0,
    outputTokens: ev.outputTokens ?? prev?.outputTokens ?? 0,
    cacheCreationInputTokens: ev.cacheCreationInputTokens ?? prev?.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: ev.cacheReadInputTokens ?? prev?.cacheReadInputTokens ?? 0,
  };
}
