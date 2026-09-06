import type { ApiProvider, ForkSystemInput, ProviderConfig } from "@/engine/contract/types.ts";
import type { CatalogModel } from "@/engine/model/catalog.ts";
import { parseModelId } from "@/engine/model/catalog.ts";
import { PERMISSIVE_DEFERRED } from "@/engine/providers/_shared/effort-defaults.ts";
import { ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import { fingerprint } from "@/engine/providers/anthropic/_infra/fingerprint.ts";
import { checkOpus1mAccess, checkSonnet1mAccess } from "@/engine/providers/anthropic/access.ts";
import { Auth, beginLogin as anthropicBeginLogin } from "@/engine/providers/anthropic/auth.ts";
import {
  applyTrailingCacheControl,
  composeAnthropicMessages,
} from "@/engine/providers/anthropic/compose.ts";
import { SUBAGENT_OPENER, subagentBillingHeader } from "@/engine/providers/anthropic/preamble.ts";
import { anthropicPromptAdapter } from "@/engine/providers/anthropic/prompt-adapter.ts";
import { markThinkingReplayRejected } from "@/engine/providers/anthropic/reasoning-state.ts";
import { anthropicStream } from "@/engine/providers/anthropic/stream.ts";
import {
  translateRequestAnthropic as translateRequest,
  translateResponseAnthropic as translateResponse,
} from "@/engine/providers/anthropic/translate.ts";
import { searchAnthropic } from "@/engine/tools/anthropic.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import { CACHE_CONTROL_1H } from "@/engine/transport/cache/index.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import { providerDisplayName } from "@/kernel/std/types/provider-ids.ts";

const PROVIDER: ApiProvider<"anthropic-messages"> = {
  id: "anthropic",
  api: "anthropic-messages",
  sourceId: "builtin",
  label: providerDisplayName("anthropic"),
  shortKey: "anthropic",
};

// Total stream attempts for HTTP 529 / overloaded before failing terminal.
const ANTHROPIC_OVERLOAD_MAX_ATTEMPTS = 3;

export type AnthropicModelAugment = { cacheBreakpoints?: number };

export const MODELS: readonly CatalogModel<AnthropicModelAugment>[] = [
  {
    id: "claude-opus-5",
    displayName: "Opus 5",
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 967_000,
    provider: "anthropic",
    supportsPdf: true,
    supports1m: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
  },
  {
    id: "claude-fable-5-1",
    displayName: "Fable 5.1",
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 967_000,
    provider: "anthropic",
    supportsPdf: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
  },
  {
    id: "claude-fable-5",
    displayName: "Fable 5",
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 967_000,
    provider: "anthropic",
    supportsPdf: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
  },
  {
    id: "claude-opus-4-8",
    displayName: "Opus 4.8",
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 967_000,
    provider: "anthropic",
    supportsPdf: true,
    supports1m: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "xhigh",
  },
  {
    id: "claude-opus-4-7",
    displayName: "Opus 4.7",
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 967_000,
    provider: "anthropic",
    supportsPdf: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "xhigh",
  },
  {
    id: "claude-sonnet-5",
    displayName: "Sonnet 5",
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 967_000,
    provider: "anthropic",
    supportsPdf: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
  },
  {
    id: "claude-haiku-4-5",
    displayName: "Haiku 4.5",
    contextWindow: 200_000,
    autoCompactTokenLimit: 167_000,
    provider: "anthropic",
    supportsPdf: true,
    onDemand: true,
    efforts: [],
    defaultEffort: null,
  },
];

function modelAvailable(modelId: string): boolean {
  const parsed = parseModelId(modelId);
  if (!parsed.is1m) return true;
  if (parsed.base.includes("claude-opus")) return checkOpus1mAccess();
  if (parsed.base.includes("claude-sonnet")) return checkSonnet1mAccess();
  return true;
}

// A replayed thinking block whose signature the API can no longer verify
// (history that crossed a provider or credential switch) is rejected as a 400.
// Each rejection shape names the thinking block directly, so a plain validation
// error on some other field never suppresses the session.
function carriesThinkingReplayRejection(err: unknown, body: string): boolean {
  if (!(err instanceof ProviderHttpError) || err.status !== 400) return false;
  const message = err instanceof Error ? err.message : "";
  const haystack = `${body}\n${message}`;
  return /thinking blocks cannot be modified|must start with a thinking block|invalid[^\n]{0,24}signature[^\n]{0,24}thinking/i.test(
    haystack,
  );
}

function composeForkSystem(input: ForkSystemInput): ContentBlock[] {
  const sysBody = input.body.trim().length > 0 ? input.body : `You are the ${input.name} fork.`;
  const folded = input.envTail ? `${sysBody}\n\n${input.envTail}` : sysBody;
  return [
    { type: "text", text: subagentBillingHeader(input.firstPrompt, input.previousRequestId) },
    { type: "text", text: SUBAGENT_OPENER, cache_control: CACHE_CONTROL_1H },
    { type: "text", text: folded, cache_control: CACHE_CONTROL_1H },
  ];
}

export const config: ProviderConfig<"anthropic-messages"> = {
  provider: PROVIDER,
  legacyModels: MODELS,
  auth: Auth,
  signupHint: "OAuth — Anthropic",
  fingerprint,
  translateRequest,
  translateResponse,
  stream: anthropicStream,
  featureFlags: {
    fastMode: false,
    thinkingSuffix: true,
    supportsImages: true,
  },
  defaultModelId: () => "claude-opus-5",
  fallbackEfforts: {
    levels: ["low", "medium", "high", "xhigh", "max"],
    default: "high",
  },
  deferredOverrides: PERMISSIVE_DEFERRED,
  promptAdapter: anthropicPromptAdapter,
  recoverableError: (err, ctx, attempt) => {
    const body = err instanceof ProviderHttpError ? err.body : "";
    // A replayed thinking block was rejected. Drop thinking replay for the rest
    // of the session and retry once — the rebuilt body omits it. Only the first
    // hit retries; a still-failing turn falls through to a normal failure.
    if (carriesThinkingReplayRejection(err, body) && markThinkingReplayRejected(ctx.sessionId)) {
      return { kind: "retry", delayMs: 0, reason: "dropped stale thinking replay" };
    }
    const decision = classifyProviderError(err, {
      attempt: attempt ?? 1,
      provider: ctx.provider,
      model: ctx.model,
    });
    // Cap 529/overload fallbacks so a sustained capacity blip fails after a few
    // tries instead of chewing the full stream retry budget.
    if (
      decision.kind === "retry" &&
      decision.status === 529 &&
      (attempt ?? 1) >= ANTHROPIC_OVERLOAD_MAX_ATTEMPTS
    ) {
      return {
        kind: "fail",
        reason: decision.reason,
        userMessage: decision.reason,
        status: decision.status,
        message: decision.message,
      };
    }
    return decision;
  },
  webSearch: searchAnthropic,
  usageDetails: { sourceLabel: "Anthropic OAuth", hasPlanPanel: true },
  beginLogin: { kind: "oauth_pkce", begin: anthropicBeginLogin },
  composeMessages: composeAnthropicMessages,
  applyTrailingCacheControl,
  composeForkSystem,
  composeForkUserBlock: (prompt) => ({
    type: "text",
    text: prompt,
    cache_control: CACHE_CONTROL_1H,
  }),
  modelAvailable,
  streamEmitsKeepalive: true,
  // The edge sends `event: ping` ~every 25s, so the byte-level transport
  // watchdog owns dead-stream detection. Fork turns drop the streamed thinking
  // summary (see translate.ts), so a heavy-reasoning phase emits zero
  // ProviderEvents for minutes on an otherwise-live socket; raise the
  // content-idle deadline as the backstop so it never false-stalls a healthy
  // think before the first content block.
  contentIdleTimeoutMs: 600_000,
};
