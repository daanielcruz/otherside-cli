import { listEnabledHookEntries } from "@/engine/plugins/registry.ts";
import { QuotaExhaustedError } from "@/engine/providers/_shared/retry.ts";
import * as providers from "@/engine/providers/registry.ts";
import { appendRecord } from "@/engine/session/persist.ts";
import { nowIso } from "@/engine/session/record/index.ts";
import { shrinkToolResultRecord } from "@/engine/session/state.ts";
import {
  appendTaskReminderMessage,
  buildTaskReminderInjection,
} from "@/engine/session/task-reminder.ts";
import {
  applyToolResultBudget,
  createContentReplacementState,
} from "@/engine/tool-result-storage/index.ts";
import { providerToolDeclarations, runRound } from "@/engine/translator/index.ts";
import type { InjectionQueue } from "@/harness/composer/injections.ts";
import { loadRulesSync } from "@/kernel/permissions/persist.ts";
import type { AgentEvent, ProviderEvent } from "@/kernel/std/types/events.ts";
import { sessionGitStatus } from "../git-status.ts";
import { runPromptClassifier } from "../goal-evaluation.ts";
import { makeRequestContext } from "../request-context.ts";
import type { StopConditionVerdict } from "../stop-hook-classifier.ts";
import { currentLocalISODate } from "../turn-prompts.ts";
import type { AgentDeps, TurnLoopHost } from "./types.ts";

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

export async function* openProviderStream(
  deps: TurnStreamDeps,
  abortSignal?: AbortSignal,
): AsyncIterable<ProviderEvent> {
  const ctx = makeRequestContext(deps.agentDeps, deps.turnId);
  if (abortSignal) ctx.abortSignal = abortSignal;
  const provider = providers.get(ctx.provider);
  if (!deps.agentDeps.session.contentReplacementState) {
    deps.agentDeps.session.contentReplacementState = createContentReplacementState();
  }
  const budgetMessages = await applyToolResultBudget(
    deps.agentDeps.session.messages,
    deps.agentDeps.session.contentReplacementState,
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
  });
  const taskReminder = buildTaskReminderInjection({
    messages: deps.agentDeps.session.messages,
    scope: undefined,
    effectiveTools,
  });
  if (taskReminder !== null) {
    appendTaskReminderMessage(deps.agentDeps.session.messages, taskReminder);
  }
  const gitStatus = await sessionGitStatus();
  yield* runRound({
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
  });
}

export async function* fireStopPromptHooks(
  deps: TurnStreamDeps,
  abortSignal?: AbortSignal,
): AsyncGenerator<AgentEvent, boolean> {
  const entries = [...(deps.agentDeps.config.hooks?.stop ?? []), ...listEnabledHookEntries("stop")];
  if (entries.length === 0) return false;
  let blocked = false;
  for (const entry of entries) {
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
