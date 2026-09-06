import { findModel } from "@/engine/model/catalog.ts";
import {
  modelAutoCompactTrigger,
  modelBlockingCeiling,
  providerCompactOutputLimit,
} from "@/engine/session/compact/index.ts";
import {
  estimateConversationTokens,
  getAuthoritativeUsage,
  totalInputTokensFromUsage,
} from "@/engine/session/compact/token-count.ts";
import {
  type CompactOrchestrationDeps,
  computeUsedContextTokens,
  resolveCompactWindow,
} from "./support.ts";

export type ContextOverflow =
  | { kind: "prefix"; message: string }
  | { kind: "compactible"; message: string };

function prefixOverflowMessage(input: { prefixTokens: number; window: number }): string {
  return `context too large to send (~${input.prefixTokens.toLocaleString()} / ${input.window.toLocaleString()} tokens). The system prompt, tool definitions, and attachments alone exceed the window — compaction cannot help. Switch to a model with larger context, remove large attachments, or start a new session.`;
}

function compactibleOverflowMessage(input: { used: number; window: number }): string {
  return `context too large to send (~${input.used.toLocaleString()} / ${input.window.toLocaleString()} tokens). Run /compact, switch to a model with larger context, or start a new session.`;
}

function computePrefixOverflowTokens(deps: CompactOrchestrationDeps): number | null {
  const lastUsage = deps.agentDeps.getLastUsage?.() ?? null;
  const usage = getAuthoritativeUsage(deps.agentDeps.session.messages, lastUsage);
  if (!usage) return null;
  const totalInputTokens = totalInputTokensFromUsage(usage);
  const messagesEstimate = estimateConversationTokens(deps.agentDeps.session.messages);
  return Math.max(0, totalInputTokens - messagesEstimate);
}

export function checkContextOverflow(deps: CompactOrchestrationDeps): ContextOverflow | null {
  const state = deps.agentDeps.broker.read();
  const model = findModel({ provider: state.provider, model: state.model });
  if (!model) return null;
  const window = resolveCompactWindow(model);
  const maxOutput = providerCompactOutputLimit({ provider: state.provider, model: state.model });
  const lastUsage = deps.agentDeps.getLastUsage?.() ?? null;
  const used = computeUsedContextTokens(
    deps.agentDeps.session.messages,
    lastUsage,
    state.provider,
    state.model,
  );
  const hardCap = modelBlockingCeiling({ model, window, maxOutputTokens: maxOutput });
  if (used <= hardCap) return null;
  const prefixTokens = computePrefixOverflowTokens(deps);
  const threshold = modelAutoCompactTrigger({
    model,
    window,
    maxOutputTokens: maxOutput,
    provider: state.provider,
  });
  if (prefixTokens !== null && prefixTokens > threshold) {
    return { kind: "prefix", message: prefixOverflowMessage({ prefixTokens, window }) };
  }
  return { kind: "compactible", message: compactibleOverflowMessage({ used, window }) };
}
