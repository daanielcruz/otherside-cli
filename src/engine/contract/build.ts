import {
  defaultComposeForkSystem,
  defaultComposeForkUserBlock,
} from "@/engine/contract/defaults/fork-compose.ts";
import { defaultInjectHeaders } from "@/engine/contract/defaults/inject-headers.ts";
import { prepareRequestImages } from "@/engine/contract/defaults/prepare-request-images.ts";
import { mediaItemLimitFor, stripExcessMedia } from "@/engine/contract/defaults/strip-media.ts";
import type { Provider, ProviderConfig } from "@/engine/contract/types.ts";
import type { ModelEntry } from "@/engine/model/catalog.ts";
import type { Api } from "@/engine/translator/dispatch/types.ts";
import {
  getContentIdleTimeoutMs,
  wrapProviderEventsWithContentIdleTimeout,
} from "@/kernel/std/stream/content-idle-timeout.ts";
import {
  KEEPALIVE_BYTE_SILENCE_LIMIT_MS,
  maybeGuardByteIterableSilence,
} from "@/kernel/std/stream/idle-timeout.ts";

export function buildProvider<A extends Api>(config: ProviderConfig<A>): Provider {
  const fingerprint = requireField(config, "fingerprint");
  const translateRequest = requireField(config, "translateRequest");
  const translateResponse = requireField(config, "translateResponse");
  const stream = requireField(config, "stream");
  const featureFlags = requireField(config, "featureFlags");
  const defaultModelId = requireField(config, "defaultModelId");
  const fallbackEfforts = requireField(config, "fallbackEfforts");
  const deferredOverrides = requireField(config, "deferredOverrides");
  const promptAdapter = requireField(config, "promptAdapter");
  const recoverableError = requireField(config, "recoverableError");
  const usageDetails = requireField(config, "usageDetails");
  const beginLogin = requireField(config, "beginLogin");
  const composeMessages = requireField(config, "composeMessages");
  const auth = requireField(config, "auth");

  const composeForkSystem = config.composeForkSystem ?? defaultComposeForkSystem;
  const composeForkUserBlock = config.composeForkUserBlock ?? defaultComposeForkUserBlock;
  const modelAvailable = config.modelAvailable ?? (() => true);
  const allowsCustomModel = config.allowsCustomModel ?? false;
  const models = (): readonly ModelEntry[] =>
    typeof config.legacyModels === "function" ? config.legacyModels() : (config.legacyModels ?? []);

  return {
    id: config.provider.id,
    auth,
    label: config.provider.label,
    shortKey: config.provider.shortKey,
    ...(config.signupHint !== undefined ? { signupHint: config.signupHint } : {}),
    featureFlags: () => featureFlags,
    modelAvailable: (modelId) => modelAvailable(modelId),
    defaultModelId: () =>
      typeof defaultModelId === "function" ? defaultModelId() : defaultModelId,
    fallbackEfforts: () => fallbackEfforts,
    allowsCustomModel: () => allowsCustomModel,
    fingerprint,
    injectHeaders: (ctx) => defaultInjectHeaders(ctx, fingerprint),
    // Requests with too many media items (or too many media bytes) are
    // rejected server-side with a confusing error. Prepare route-safe copies,
    // then silently drop the OLDEST media right before the body is built.
    translateRequest: (ctx, messages, tools) => {
      const prepared = prepareRequestImages(messages, {
        provider: ctx.provider,
        model: ctx.model,
      });
      return translateRequest(
        ctx,
        stripExcessMedia(prepared, mediaItemLimitFor(ctx.model, models())),
        tools,
      );
    },
    startStreamAttempt: (ctx, body) => {
      const attemptAbort = new AbortController();
      const signal = ctx.abortSignal
        ? AbortSignal.any([ctx.abortSignal, attemptAbort.signal])
        : attemptAbort.signal;
      const raw = maybeGuardByteIterableSilence(
        stream(ctx, body, signal),
        config.streamEmitsKeepalive ? KEEPALIVE_BYTE_SILENCE_LIMIT_MS : undefined,
        (error) => attemptAbort.abort(error),
      );
      return {
        events: wrapProviderEventsWithContentIdleTimeout(translateResponse(raw), {
          timeoutMs: getContentIdleTimeoutMs(config.contentIdleTimeoutMs),
          onTimeout: (error) => attemptAbort.abort(error),
        }),
        abort: (reason) => attemptAbort.abort(reason),
      };
    },
    defaultModels: () => [...models()],
    deferredOverrides: () => deferredOverrides,
    promptAdapter: () => promptAdapter,
    recoverableError,
    ...(config.getResumeBody ? { getResumeBody: config.getResumeBody } : {}),
    ...(config.webSearch ? { webSearch: config.webSearch } : {}),
    ...(config.applyTrailingCacheControl
      ? { applyTrailingCacheControl: config.applyTrailingCacheControl }
      : {}),
    ...(config.onCompactionSucceeded
      ? { onCompactionSucceeded: config.onCompactionSucceeded }
      : {}),
    usageDetails: () => usageDetails,
    beginLogin: () => beginLogin,
    composeForkSystem,
    composeForkUserBlock,
    composeMessages,
  };
}

function requireField<A extends Api, K extends keyof ProviderConfig<A>>(
  config: ProviderConfig<A>,
  key: K,
): NonNullable<ProviderConfig<A>[K]> {
  const v = config[key];
  if (v == null)
    throw new Error(`ProviderConfig[${config.provider.id}].${String(key)} is required`);
  return v as NonNullable<ProviderConfig<A>[K]>;
}
