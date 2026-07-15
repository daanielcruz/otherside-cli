import {
  askGroupWithDefault,
  type GroupQuestion,
  type GroupResult,
} from "@/kernel/channels/ask.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { getRuntimeKind, type RuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import type { TierCandidateDetail } from "../tier/resolver.ts";

export type ModelFallbackDecision = "use_fallback" | "wait";

export interface ModelFallbackEndpoint {
  provider: ProviderId;
  model: string;
}

export interface ModelFallbackDeviation {
  tier: string;
  rankOne: TierCandidateDetail;
  substitute: TierCandidateDetail;
}

export interface ModelFallbackDecisionRequest {
  tier: string;
  rankOne: ModelFallbackEndpoint;
  substitute: ModelFallbackEndpoint;
  reason: string;
  untilEpochMs: number;
  expiresAt: string;
}

export interface ModelFallbackDecisionAnswer {
  decision: ModelFallbackDecision;
  timedOut: boolean;
}

export type ModelFallbackDecisionHook = (
  request: ModelFallbackDecisionRequest,
  options: { timeoutMs: number },
) => Promise<ModelFallbackDecisionAnswer>;

export interface ResolveWithModelFallbackDecisionOptions<T> {
  resolve: () => T;
  inspect: (value: T) => ModelFallbackDeviation | null;
  decisionHook?: ModelFallbackDecisionHook;
  timeoutMs?: number;
  runtimeKind?: () => RuntimeKind;
  sleepUntil?: (untilEpochMs: number) => Promise<void>;
}

export interface ResolveWithModelFallbackDecisionResult<T> {
  value: T;
  decision: ModelFallbackDecision;
  asked: boolean;
  waited: boolean;
  timedOut: boolean;
}

export const MODEL_FALLBACK_DEFAULT_TIMEOUT_MS = 30_000;

const USE_FALLBACK_LABEL = "Use fallback";
const WAIT_LABEL = "Wait";

function endpointLabel(endpoint: ModelFallbackEndpoint): string {
  return `${endpoint.provider}/${endpoint.model}`;
}

function formatExpiry(untilEpochMs: number): string {
  return new Date(untilEpochMs).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function fallbackQuestion(request: ModelFallbackDecisionRequest): string {
  return `Model fallback: ${endpointLabel(request.rankOne)} is cooling down (${request.reason}, expires ${request.expiresAt}). Use ${endpointLabel(request.substitute)}?`;
}

function defaultResult(question: string): GroupResult {
  return {
    declined: false,
    answers: [{ question, answer: USE_FALLBACK_LABEL }],
  };
}

function questionForRequest(request: ModelFallbackDecisionRequest): GroupQuestion {
  return {
    question: fallbackQuestion(request),
    options: [
      {
        label: USE_FALLBACK_LABEL,
        description: `Continue now with ${endpointLabel(request.substitute)}.`,
      },
      {
        label: WAIT_LABEL,
        description: `Pause until ${endpointLabel(request.rankOne)} cooldown expires, then route again.`,
      },
    ],
    multiSelect: false,
  };
}

export const defaultModelFallbackDecisionHook: ModelFallbackDecisionHook = async (
  request,
  options,
) => {
  const question = questionForRequest(request);
  const { result, timedOut } = await askGroupWithDefault(
    [question],
    options.timeoutMs,
    defaultResult(question.question),
  );
  if (result.declined) return { decision: "use_fallback", timedOut };
  const answer = result.answers[0]?.answer;
  return { decision: answer === WAIT_LABEL ? "wait" : "use_fallback", timedOut };
};

export function rankOneCooldownDeviation(
  tier: string,
  candidates: TierCandidateDetail[],
  selected: TierCandidateDetail | null | undefined,
): ModelFallbackDeviation | null {
  if (selected === undefined || selected === null || selected.rank === 1) return null;
  const rankOne = candidates.find((candidate) => candidate.rank === 1);
  if (!rankOne?.blocked || rankOne.cooldownUntilEpochMs === null) return null;
  return { tier, rankOne, substitute: selected };
}

export function routingNoticeForDeviation(deviation: ModelFallbackDeviation): string {
  const reasons = deviation.rankOne.blockedReasons.join(", ");
  return `Tier "${deviation.tier}" rank-1 routing is cooled down (${endpointLabel(deviation.rankOne)}: ${reasons}); using ${endpointLabel(deviation.substitute)}.`;
}

export function requestForDeviation(
  deviation: ModelFallbackDeviation,
): ModelFallbackDecisionRequest {
  const reason = deviation.rankOne.blockedReasons.join(", ") || "cooldown active";
  const untilEpochMs = deviation.rankOne.cooldownUntilEpochMs ?? Date.now();
  return {
    tier: deviation.tier,
    rankOne: {
      provider: deviation.rankOne.provider,
      model: deviation.rankOne.model,
    },
    substitute: {
      provider: deviation.substitute.provider,
      model: deviation.substitute.model,
    },
    reason,
    untilEpochMs,
    expiresAt: formatExpiry(untilEpochMs),
  };
}

export async function sleepUntilEpochMs(untilEpochMs: number): Promise<void> {
  const delayMs = Math.max(0, untilEpochMs - Date.now());
  if (delayMs === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export async function resolveWithModelFallbackDecision<T>(
  options: ResolveWithModelFallbackDecisionOptions<T>,
): Promise<ResolveWithModelFallbackDecisionResult<T>> {
  const value = options.resolve();
  const deviation = options.inspect(value);
  if (deviation === null) {
    return { value, decision: "use_fallback", asked: false, waited: false, timedOut: false };
  }

  const runtimeKind = options.runtimeKind ?? getRuntimeKind;
  if (runtimeKind() !== "interactive") {
    return { value, decision: "use_fallback", asked: false, waited: false, timedOut: false };
  }

  const decisionHook = options.decisionHook ?? defaultModelFallbackDecisionHook;
  const answer = await decisionHook(requestForDeviation(deviation), {
    timeoutMs: options.timeoutMs ?? MODEL_FALLBACK_DEFAULT_TIMEOUT_MS,
  });
  if (answer.decision !== "wait") {
    return {
      value,
      decision: "use_fallback",
      asked: true,
      waited: false,
      timedOut: answer.timedOut,
    };
  }

  const sleepUntil = options.sleepUntil ?? sleepUntilEpochMs;
  await sleepUntil(deviation.rankOne.cooldownUntilEpochMs ?? Date.now());
  return {
    value: options.resolve(),
    decision: "wait",
    asked: true,
    waited: true,
    timedOut: answer.timedOut,
  };
}
