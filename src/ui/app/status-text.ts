import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { findModel } from "@/engine/model/catalog.ts";
import {
  getModelAutoCompactThreshold,
  maxOutputTokensForModel,
  resolveAutoCompactWindow,
} from "@/engine/session/compact/index.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { fireUserPromptSubmitHooks } from "@/kernel/hooks/handler.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";

export function computeAutoCompactRemainingPct(
  usedTokens: number,
  modelId: string,
  providerId: ProviderId,
): number | undefined {
  const model = findModel(modelId, providerId);
  if (!model) return undefined;
  if (model.contextWindow <= 0) return undefined;
  const window = resolveAutoCompactWindow(model.contextWindow).window;
  const threshold = getModelAutoCompactThreshold({
    model,
    window,
    maxOutputTokens: maxOutputTokensForModel(modelId),
    provider: providerId,
  });
  if (threshold <= 0) return undefined;
  if (usedTokens < threshold * 0.7) return undefined;
  if (usedTokens >= threshold) return 0;
  return Math.max(1, Math.round((1 - usedTokens / threshold) * 100));
}

export function bgPillLabelFor(tasks: BackgroundTask[]): string | undefined {
  const visible = tasks.filter((t) => t.isBackgrounded && t.status === "running" && !t.isSidechain);
  if (visible.length === 0) return undefined;
  const n = visible.length;
  const allAgents = visible.every((t) => t.kind === "agent");
  const allShells = visible.every((t) => t.kind === "shell");
  if (allAgents) return n === 1 ? "1 local agent" : `${n} local agents`;
  if (allShells) return n === 1 ? "1 shell" : `${n} shells`;
  return n === 1 ? "1 background task" : `${n} background tasks`;
}

export function compactDoneText(info: {
  mode: "summary" | "failed";
  durationMs: number;
  truncatedMessages: number;
  error?: string;
  cancelled?: boolean;
}): string {
  const seconds = Math.max(0, Math.round(info.durationMs / 1000));
  if (info.mode === "failed") {
    // `cancelled` reflects the real abort signal and is the trustworthy source;
    // the regex is a fallback for callers/records that predate that field.
    const canceled =
      info.cancelled ??
      (info.error !== undefined && /user-cancel|aborted|cancell?ed/i.test(info.error));
    if (canceled) {
      return `Compaction canceled (${seconds}s)`;
    }
    return `Conversation compact failed (${seconds}s) — ${info.error ?? "summary fork failed"}`;
  }
  if (info.truncatedMessages > 0) {
    return `Conversation compacted (${seconds}s · truncated ${info.truncatedMessages} oldest message${info.truncatedMessages === 1 ? "" : "s"})`;
  }
  return `Conversation compacted (${seconds}s)`;
}

export function effortBadge({
  ultracode,
  effort,
  hasEffort,
}: {
  ultracode: boolean;
  effort: EffortLevel | null;
  hasEffort: boolean;
}): string | undefined {
  if (ultracode) return hasEffort && effort ? `ultracode ${effort}` : `ultracode`;
  if (hasEffort && effort) return effort;
  return undefined;
}

export function thinkingSuffixFor(provider: string, effort: EffortLevel | null): string {
  if (effort === null) return "";
  if (!getProviderConfig(provider as ProviderId)?.featureFlags?.thinkingSuffix) return "";
  return ` with ${effort} effort`;
}

export function formatHookOutcome(
  outcome: Awaited<ReturnType<typeof fireUserPromptSubmitHooks>>["outcomes"][number],
): string {
  if (outcome.kind === "non_zero_exit") return `exit ${outcome.code}`;
  if (outcome.kind === "spawn_failed") return outcome.error;
  return outcome.kind;
}
