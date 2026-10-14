import { auxiliaryModelFor } from "@/engine/model/tier/tiers.ts";
import { QuotaExhaustedError } from "@/engine/providers/_shared/retry.ts";
import * as providers from "@/engine/providers/registry.ts";
import {
  clearActiveGoal,
  getActiveGoal,
  incrementGoalIterations,
  setGoalLastReason,
} from "@/engine/queue/state.ts";
import {
  appendRecord,
  goalStatusAttachment,
  nowIso,
  type Session,
} from "@/engine/session/index.ts";
import { sanitizeMessages } from "@/engine/translator/index.ts";
import { streamWithRetry } from "@/engine/transport/_infra/classify/retry.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  buildStopConditionUserPrompt,
  clampVerdictRequest,
  parseStopConditionVerdict,
  STOP_CONDITION_SYSTEM_PROMPT,
  type StopConditionVerdict,
} from "./stop-hook-classifier.ts";
import type { GoalCheckOutcome } from "./turn/turn-ending.ts";

/** How long a goal check may run before the turn ends without its verdict. */
export const GOAL_CHECK_TIMEOUT_MS = 30_000;

export interface GoalEvaluationResult {
  outcome: Exclude<GoalCheckOutcome, "deferred">;
  reason?: string | undefined;
  iteration: number;
}

export interface GoalEvalDeps {
  session: Session;
  config: UserConfig;
  ctx: RequestContext;
  cancelled: () => boolean;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export async function runPromptClassifier(
  deps: GoalEvalDeps,
  condition: string,
): Promise<StopConditionVerdict> {
  const auxModel = auxiliaryModelFor(deps.ctx.provider);
  const ctx: RequestContext = {
    ...deps.ctx,
    model: auxModel === "inherit" ? deps.ctx.model : auxModel,
    agentic: false,
    effort: null,
    disableThinking: true,
  };
  if (deps.abortSignal) ctx.abortSignal = deps.abortSignal;
  const provider = providers.get(ctx.provider);
  const harness: ComposedHarness = {
    layers: [{ name: "stop-hook-classifier", body: STOP_CONDITION_SYSTEM_PROMPT }],
    combined: STOP_CONDITION_SYSTEM_PROMPT,
    systemBlocks: [{ text: STOP_CONDITION_SYSTEM_PROMPT }],
    userPrepend: [],
    midSystemPromotion: "off",
  };
  const conversation: Message[] = [
    ...deps.session.messages,
    {
      role: "user",
      content: [{ type: "text", text: buildStopConditionUserPrompt(condition) }],
    },
  ];
  const composed = provider.composeMessages(harness, sanitizeMessages(conversation));
  const body = clampVerdictRequest(provider.translateRequest(ctx, composed, []));

  let responseText = "";
  for await (const ev of streamWithRetry(ctx, provider, body)) {
    if (ev.kind === "text_delta") responseText += ev.text;
    else if (ev.kind === "stream_reset") responseText = "";
    else if (ev.kind === "quota_exhausted") {
      throw new QuotaExhaustedError({
        provider: ev.provider,
        model: ev.model,
        resetEpochMs: ev.resetEpochMs,
        message: ev.message,
      });
    } else if (ev.kind === "error") {
      throw new Error(ev.error);
    } else if (ev.kind === "message_stop") {
      break;
    }
  }
  const verdict = parseStopConditionVerdict(responseText);
  if (verdict === null) {
    throw new Error(
      `response was not a valid verdict JSON object: ${responseText.trim().slice(0, 200)}`,
    );
  }
  return verdict;
}

export async function* evaluateGoal(
  deps: GoalEvalDeps,
): AsyncGenerator<AgentEvent, GoalEvaluationResult | undefined> {
  const goal = getActiveGoal(deps.session.id);
  if (!goal) return undefined;
  incrementGoalIterations(deps.session.id);
  const updated = getActiveGoal(deps.session.id);
  const iteration = updated?.iterations ?? goal.iterations;
  yield { kind: "goal_eval_start", condition: goal.condition, iteration };

  // The check gets its own deadline; the turn's signal still cancels it.
  const check = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    check.abort("goal-check-timeout");
  }, deps.timeoutMs ?? GOAL_CHECK_TIMEOUT_MS);
  const stopWithTurn = (): void => check.abort(deps.abortSignal?.reason);
  if (deps.abortSignal?.aborted) stopWithTurn();
  else deps.abortSignal?.addEventListener("abort", stopWithTurn, { once: true });
  let verdict: StopConditionVerdict;
  try {
    verdict = await runPromptClassifier({ ...deps, abortSignal: check.signal }, goal.condition);
  } catch (err) {
    if (timedOut) return { outcome: "timed_out", iteration };
    if (deps.cancelled() || deps.abortSignal?.aborted) return undefined;
    if (err instanceof QuotaExhaustedError) {
      yield {
        kind: "quota_exhausted",
        provider: err.provider,
        model: err.model,
        resetEpochMs: err.resetEpochMs,
        message: err.message,
      };
    }
    return { outcome: "failed", iteration };
  } finally {
    clearTimeout(deadline);
    deps.abortSignal?.removeEventListener("abort", stopWithTurn);
  }
  if (verdict.ok) {
    clearActiveGoal(deps.session.id);
    await appendRecord(deps.session, {
      type: "attachment",
      ts: nowIso(),
      attachment: goalStatusAttachment(goal.condition, {
        met: true,
        iteration,
      }),
    }).catch(() => {});
    yield { kind: "goal_met", condition: goal.condition, iteration };
    return { outcome: "met", iteration };
  }

  const reason = verdict.reason;
  if (verdict.impossible === true) {
    clearActiveGoal(deps.session.id);
    await appendRecord(deps.session, {
      type: "attachment",
      ts: nowIso(),
      attachment: goalStatusAttachment(goal.condition, {
        met: false,
        failed: true,
        reason,
        iteration,
      }),
    }).catch(() => {});
    yield { kind: "goal_not_met", condition: goal.condition, iteration, reason };
    return { outcome: "impossible", reason, iteration };
  }

  setGoalLastReason(deps.session.id, reason);
  await appendRecord(deps.session, {
    type: "attachment",
    ts: nowIso(),
    attachment: goalStatusAttachment(goal.condition, {
      met: false,
      reason,
      iteration,
    }),
  }).catch(() => {});
  yield { kind: "goal_not_met", condition: goal.condition, iteration, reason };
  return { outcome: "not_met", reason, iteration };
}

export function goalContinuePrompt(condition: string, reason: string): string {
  return `Stop hook feedback:\n[${condition}]: ${reason}`;
}
