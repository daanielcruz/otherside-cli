import type { ApiProvider, ProviderConfig } from "@/engine/contract/types.ts";
import type { Model } from "@/engine/model/types.ts";
import { composeFlatMessages } from "@/engine/providers/_shared/compose-flat.ts";
import { NO_EFFORT_AUTO, PERMISSIVE_DEFERRED } from "@/engine/providers/_shared/effort-defaults.ts";
import { Auth, currentConfig } from "@/engine/providers/openai/auth.ts";
import { fingerprint } from "@/engine/providers/openai/fingerprint.ts";
import { fetchModelsForConfig } from "@/engine/providers/openai/models.ts";
import { openaiPromptAdapter } from "@/engine/providers/openai/prompt-adapter.ts";
import { openaiCompletionsStream } from "@/engine/providers/openai/stream.ts";
import { translateRequest, translateResponse } from "@/engine/providers/openai/translate.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";

const PROVIDER: ApiProvider<"openai-completions"> = {
  id: "openai-custom",
  api: "openai-completions",
  sourceId: "builtin",
  label: "OpenAI Custom",
  shortKey: "openai",
};

export const config: ProviderConfig<"openai-completions"> = {
  provider: PROVIDER,
  legacyModels: [],
  async asyncFactory(): Promise<readonly Model<"openai-completions">[]> {
    try {
      const cfg = await currentConfig();
      const result = await fetchModelsForConfig(cfg.baseUrl, cfg.apiKey);
      return result.models.map((m) => ({
        api: "openai-completions",
        provider: "openai-custom",
        id: m.id,
        displayName: m.displayName ?? m.id,
        contextWindow: m.contextWindow ?? 0,
        maxTokens: cfg.outputTokenLimit ?? 0,
        input: ["text"],
        cost: { inputPerM: 0, outputPerM: 0, currency: "USD" },
        reasoning: false,
        effortLevels: [],
        defaultEffort: null,
        compat: {
          api: "openai-completions",
          endpointKind: "chat_completions",
          supportsStore: false,
        },
      }));
    } catch {
      return [];
    }
  },
  auth: Auth,
  signupHint: "API key + base URL",
  fingerprint,
  translateRequest,
  translateResponse,
  stream: openaiCompletionsStream,
  featureFlags: {
    fastMode: false,
    effortSuffix: false,
    thinkingSuffix: false,
    supportsImages: true,
  },
  defaultModelId: "",
  fallbackEfforts: NO_EFFORT_AUTO,
  allowsCustomModel: true,
  deferredOverrides: PERMISSIVE_DEFERRED,
  promptAdapter: openaiPromptAdapter,
  recoverableError: (err, _ctx, attempt) => classifyProviderError(err, { attempt: attempt ?? 1 }),
  usageDetails: { sourceLabel: "Custom endpoint" },
  beginLogin: { kind: "openai_custom" },
  composeMessages: composeFlatMessages,
};
