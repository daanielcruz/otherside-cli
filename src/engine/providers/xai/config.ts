import type { ApiProvider, ProviderConfig } from "@/engine/contract/types.ts";
import { composeFlatMessages } from "@/engine/providers/_shared/compose-flat.ts";
import { ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import { Auth, beginLogin as xaiBeginLogin } from "@/engine/providers/xai/auth.ts";
import { fingerprint } from "@/engine/providers/xai/fingerprint.ts";
import { GROK_MODELS } from "@/engine/providers/xai/models.ts";
import { xaiPromptAdapter } from "@/engine/providers/xai/prompt-adapter.ts";
import { markEncryptedReasoningRejected } from "@/engine/providers/xai/reasoning-state.ts";
import { xaiStream } from "@/engine/providers/xai/stream.ts";
import {
  translateRequestGrok as translateRequest,
  translateResponseGrok as translateResponse,
} from "@/engine/providers/xai/translate.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import { providerDisplayName } from "@/kernel/std/types/provider-ids.ts";

// xAI's chat proxy is the OpenAI Responses protocol, so grok rides the
// `codex-responses` Api tag. There is no runtime dispatch on the Api literal —
// grok ships its own translate/stream — this only satisfies the compile-time
// provider typing.
const PROVIDER: ApiProvider<"codex-responses"> = {
  id: "xai",
  api: "codex-responses",
  sourceId: "builtin",
  label: providerDisplayName("xai"),
  shortKey: "xai",
};

// Soft 429s on this surface settle or become hard limits quickly; two attempts
// (one retry) is the local budget — not the shared DEFAULT_MAX_ATTEMPTS=10.
const XAI_RATE_LIMIT_MAX_ATTEMPTS = 2;

// A replayed encrypted-reasoning blob whose chain was broken (provider switch)
// is rejected by the chat proxy. xAI rides the same Responses protocol as codex,
// but words the rejection in active voice ("Could not decrypt the provided
// encrypted_content") where codex uses passive ("encrypted content could not be
// verified/decrypted/parsed") — match both shapes. Requiring both halves keeps
// a plain reasoning-param validation error (e.g. an unsupported
// reasoning_effort → "invalid-argument") from wrongly suppressing the session.
function carriesEncryptedReasoningRejection(err: unknown, body: string): boolean {
  const message = err instanceof Error ? err.message : "";
  const haystack = `${body}\n${message}`;
  return (
    /encrypted[ _]content/i.test(haystack) &&
    /could not (be (verified|decrypted|parsed)|(verify|decrypt|parse))/i.test(haystack)
  );
}

export const config: ProviderConfig<"codex-responses"> = {
  provider: PROVIDER,
  legacyModels: GROK_MODELS,
  auth: Auth,
  signupHint: "OAuth — grok.com",
  fingerprint,
  translateRequest,
  translateResponse,
  stream: xaiStream,
  // Grok reasoning stretches emit tiny summaries with >10min gaps between
  // parsed events while the proxy keeps bytes flowing, so the content deadline
  // stays generous; the default-on byte watchdog (300s) still catches a dead
  // socket independently.
  contentIdleTimeoutMs: 1_800_000,
  featureFlags: {
    fastMode: false,
    thinkingSuffix: true,
    supportsImages: false,
  },
  defaultModelId: "grok-4.6",
  fallbackEfforts: { levels: ["low", "medium", "high", "xhigh"], default: "high" },
  // WebSearch is served by the hosted web_search tool the translator injects, so
  // keep it out of the client catalog (no local DuckDuckGo fallback for xai).
  deferredOverrides: {
    excludeFromCatalog: ["WebSearch"],
    alwaysDeclare: [],
    emitDeferredReminder: true,
  },
  promptAdapter: xaiPromptAdapter,
  recoverableError: (err, ctx, attempt) => {
    const body = err instanceof ProviderHttpError ? err.body : "";
    if (
      carriesEncryptedReasoningRejection(err, body) &&
      markEncryptedReasoningRejected(ctx.sessionId)
    ) {
      return { kind: "retry", delayMs: 0, reason: "dropped stale encrypted reasoning" };
    }
    const decision = classifyProviderError(err, {
      attempt: attempt ?? 1,
      provider: ctx.provider,
      model: ctx.model,
    });
    if (
      decision.kind === "retry" &&
      decision.status === 429 &&
      (attempt ?? 1) >= XAI_RATE_LIMIT_MAX_ATTEMPTS
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
  usageDetails: { sourceLabel: "SuperGrok OAuth" },
  beginLogin: { kind: "oauth_pkce", begin: xaiBeginLogin },
  composeMessages: composeFlatMessages,
};
