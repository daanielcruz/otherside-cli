import { findModel } from "@/engine/model/catalog.ts";
import {
  modelAutoCompactTrigger,
  providerCompactOutputLimit,
} from "@/engine/session/compact/index.ts";
import {
  applyTimeBasedMicroCompact,
  applyTokenBasedMicroCompact,
  getMicroCompactConfig,
  MICRO_COMPACT_CLEARED_MESSAGE,
} from "@/engine/session/compact/micro.ts";
import { appendRecord, nowIso, shrinkToolResultRecord } from "@/engine/session/index.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import {
  type CompactOrchestrationDeps,
  computeUsedContextTokens,
  findLastAssistantTs,
  resolveCompactWindow,
} from "./support.ts";

export async function* maybeMicroCompact(
  deps: CompactOrchestrationDeps,
): AsyncIterable<AgentEvent> {
  if (deps.agentDeps.config.autoCompact === false) return;
  if (process.env.DISABLE_COMPACT || process.env.DISABLE_AUTO_COMPACT) return;
  const state = deps.agentDeps.broker.read();
  const model = findModel({ provider: state.provider, model: state.model });
  if (!model) return;
  const window = resolveCompactWindow(model);
  const maxOutput = providerCompactOutputLimit({ provider: state.provider, model: state.model });
  const lastUsage = deps.agentDeps.getLastUsage?.() ?? null;
  const threshold = modelAutoCompactTrigger({
    model,
    window,
    maxOutputTokens: maxOutput,
    provider: state.provider,
  });
  const usedTokens = computeUsedContextTokens(
    deps.agentDeps.session.messages,
    lastUsage,
    state.provider,
    state.model,
  );
  const config = getMicroCompactConfig();
  let outcome = applyTokenBasedMicroCompact({
    messages: deps.agentDeps.session.messages,
    usedTokens,
    threshold,
    config,
  });
  if (!outcome) {
    const lastAssistantTs = findLastAssistantTs(deps.agentDeps.session.messages);
    if (lastAssistantTs !== null) {
      outcome = applyTimeBasedMicroCompact({
        messages: deps.agentDeps.session.messages,
        lastAssistantTs,
        config,
      });
    }
  }
  if (!outcome) return;
  if (outcome.clearedToolUseIds && outcome.clearedToolUseIds.length > 0) {
    for (const toolUseId of outcome.clearedToolUseIds) {
      await appendRecord(deps.agentDeps.session, {
        type: "content_replacement",
        ts: nowIso(),
        kind: "tool-result",
        toolUseId,
        replacement: MICRO_COMPACT_CLEARED_MESSAGE,
      });
      shrinkToolResultRecord(deps.agentDeps.session, toolUseId, MICRO_COMPACT_CLEARED_MESSAGE);
    }
  }
  yield {
    kind: "micro_compact",
    cleared: outcome.cleared,
    kept: outcome.kept,
    tokensSavedEstimate: outcome.tokensSavedEstimate,
    preTokens: usedTokens,
    threshold,
    clearedToolUseIds: outcome.clearedToolUseIds,
  };
}
