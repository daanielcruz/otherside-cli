import type { ApiProvider, ProviderConfig } from "@/engine/contract/types.ts";
import type { ModelEntry } from "@/engine/model/catalog.ts";
import { composeFlatMessages } from "@/engine/providers/_shared/compose-flat.ts";
import { PERMISSIVE_DEFERRED } from "@/engine/providers/_shared/effort-defaults.ts";
import { anthropicPromptAdapter } from "@/engine/providers/anthropic/prompt-adapter.ts";
import { Auth } from "@/engine/providers/deepseek/auth.ts";
import { fingerprint } from "@/engine/providers/deepseek/fingerprint.ts";
import { deepseekStream } from "@/engine/providers/deepseek/stream.ts";
import {
  translateRequestDeepseek as translateRequest,
  translateResponseDeepseek as translateResponse,
} from "@/engine/providers/deepseek/translate.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import { providerDisplayName } from "@/kernel/std/types/provider-ids.ts";

const PROVIDER: ApiProvider<"anthropic-messages"> = {
  id: "deepseek",
  api: "anthropic-messages",
  sourceId: "builtin",
  label: providerDisplayName("deepseek"),
  shortKey: "deepseek",
};

export const MODELS: readonly ModelEntry[] = [
  {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 967_000,
    provider: "deepseek",
    efforts: ["high", "max"],
    defaultEffort: "max",
  },
  {
    id: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 967_000,
    provider: "deepseek",
    efforts: ["high", "max"],
    defaultEffort: "max",
  },
];

export const config: ProviderConfig<"anthropic-messages"> = {
  provider: PROVIDER,
  legacyModels: MODELS,
  auth: Auth,
  signupHint: "API key — platform.deepseek.com",
  fingerprint,
  translateRequest,
  translateResponse,
  stream: deepseekStream,
  featureFlags: {
    fastMode: false,
    thinkingSuffix: true,
    supportsImages: false,
  },
  defaultModelId: "deepseek-v4-pro",
  fallbackEfforts: { levels: ["high", "max"], default: "max" },
  deferredOverrides: PERMISSIVE_DEFERRED,
  promptAdapter: anthropicPromptAdapter,
  recoverableError: (err, ctx, attempt) =>
    classifyProviderError(err, {
      attempt: attempt ?? 1,
      provider: ctx.provider,
      model: ctx.model,
    }),
  usageDetails: { sourceLabel: "API key" },
  beginLogin: { kind: "api_key" },
  composeMessages: composeFlatMessages,
  // DeepSeek emits `: keep-alive` SSE comments during content silence, so the
  // byte watchdog owns dead-socket detection. Content idle then means a wedged
  // model and must fail terminal rather than reconnect into the same silence.
  streamEmitsKeepalive: true,
  // Long reasoning can stay event-silent while keep-alives still flow; raise the
  // content-idle backstop so healthy think phases are not false-stalled.
  contentIdleTimeoutMs: 600_000,
};
