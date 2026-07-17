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

// xAI's chat proxy is the OpenAI Responses protocol, so grok rides the
// `codex-responses` Api tag. There is no runtime dispatch on the Api literal —
// grok ships its own translate/stream — this only satisfies the compile-time
// provider typing.
const PROVIDER: ApiProvider<"codex-responses"> = {
  id: "xai",
  api: "codex-responses",
  sourceId: "builtin",
  label: "xAI",
  shortKey: "xai",
};

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
  // Reasoning turns can stay event-silent for a while and the HTTP stream has no
  // transport keep-alive, so raise the content-idle deadline as the backstop.
  contentIdleTimeoutMs: 600_000,
  featureFlags: {
    fastMode: false,
    effortSuffix: true,
    thinkingSuffix: true,
    supportsImages: true,
  },
  defaultModelId: "grok-4.5",
  fallbackEfforts: { levels: ["low", "medium", "high"], default: "high" },
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
    return classifyProviderError(err, {
      attempt: attempt ?? 1,
      provider: ctx.provider,
      model: ctx.model,
    });
  },
  usageDetails: { sourceLabel: "SuperGrok OAuth" },
  beginLogin: { kind: "oauth_pkce", begin: xaiBeginLogin },
  composeMessages: composeFlatMessages,
};
