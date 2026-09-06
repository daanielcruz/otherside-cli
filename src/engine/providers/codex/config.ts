import type { ApiProvider, ProviderConfig } from "@/engine/contract/types.ts";
import { composeFlatMessages } from "@/engine/providers/_shared/compose-flat.ts";
import { ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import { Auth, beginLogin as codexBeginLogin } from "@/engine/providers/codex/auth.ts";
import { fingerprint } from "@/engine/providers/codex/fingerprint.ts";
import { MODELS } from "@/engine/providers/codex/models.ts";
import { codexPromptAdapter } from "@/engine/providers/codex/prompt-adapter.ts";
import { translateResponseCodex as translateResponse } from "@/engine/providers/codex/stream.ts";
import { translateRequestCodex as translateRequest } from "@/engine/providers/codex/translate.ts";
import { stream as codexStream } from "@/engine/providers/codex/transport/index.ts";
import {
  advanceWindow,
  markEncryptedReasoningRejected,
} from "@/engine/providers/codex/transport/state.ts";
import {
  CodexWsConnectionLimitError,
  isCodexWsConnectionLimitMessage,
  WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE,
  WEBSOCKET_CONNECTION_LIMIT_REACHED_MESSAGE,
} from "@/engine/providers/codex/transport/ws-router.ts";
import { searchCodex } from "@/engine/tools/codex.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import { providerDisplayName } from "@/kernel/std/types/provider-ids.ts";

function bodyCarriesConnectionLimit(body: string): boolean {
  if (isCodexWsConnectionLimitMessage(body)) return true;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    return parsed.error?.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
  } catch {
    return body.includes(`"code":"${WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE}"`);
  }
}

// Matches both the passive codex wording ("encrypted content could not be
// verified/decrypted/parsed") and the active Responses-proxy wording ("Could
// not decrypt the provided encrypted_content").
function carriesEncryptedReasoningRejection(err: unknown, body: string): boolean {
  const message = err instanceof Error ? err.message : "";
  const haystack = `${body}\n${message}`;
  return (
    /encrypted[ _]content/i.test(haystack) &&
    /could not (be (verified|decrypted|parsed)|(verify|decrypt|parse))/i.test(haystack)
  );
}

const PROVIDER: ApiProvider<"codex-responses"> = {
  id: "codex",
  api: "codex-responses",
  sourceId: "builtin",
  label: providerDisplayName("codex"),
  shortKey: "codex",
};

export const config: ProviderConfig<"codex-responses"> = {
  provider: PROVIDER,
  legacyModels: MODELS,
  auth: Auth,
  signupHint: "OAuth — chatgpt.com",
  fingerprint,
  translateRequest,
  translateResponse,
  stream: codexStream,
  onCompactionSucceeded: (ctx) => {
    advanceWindow(ctx.sessionId);
  },
  // No-summary reasoning turns emit zero ProviderEvents for minutes; the WS/HTTP
  // transport deadline (300s per data frame) owns dead-stream detection, so this
  // content deadline is only a backstop against dead-but-frame-emitting streams.
  contentIdleTimeoutMs: 600_000,
  featureFlags: {
    fastMode: true,
    thinkingSuffix: true,
    supportsImages: true,
    reasoningHeadlines: true,
  },
  defaultModelId: "gpt-6-astra",
  fallbackEfforts: {
    levels: ["low", "medium", "high", "xhigh"],
    default: "xhigh",
  },
  deferredOverrides: {
    excludeFromCatalog: [],
    alwaysDeclare: ["WebSearch"],
    emitDeferredReminder: true,
  },
  promptAdapter: codexPromptAdapter,
  recoverableError: (err, ctx, attempt) => {
    if (err instanceof CodexWsConnectionLimitError) {
      return { kind: "retry", delayMs: 0, reason: err.message };
    }
    const body = err instanceof ProviderHttpError ? err.body : "";
    if (body.length > 0 && bodyCarriesConnectionLimit(body)) {
      return {
        kind: "retry",
        delayMs: 0,
        reason: WEBSOCKET_CONNECTION_LIMIT_REACHED_MESSAGE,
      };
    }
    // A replayed reasoning encrypted_content blob was rejected (its chain was
    // broken by a provider switch). Drop encrypted reasoning for the rest of the
    // session and retry once — the rebuilt body omits it. Only the first hit
    // retries; a still-failing turn falls through to a normal failure.
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
  usageDetails: { sourceLabel: "ChatGPT OAuth" },
  beginLogin: { kind: "oauth_pkce", begin: codexBeginLogin },
  composeMessages: composeFlatMessages,
  webSearch: searchCodex,
};
