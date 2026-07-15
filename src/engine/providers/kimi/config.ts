import type { ApiProvider, ProviderConfig } from "@/engine/contract/types.ts";
import type { ModelEntry } from "@/engine/model/catalog.ts";
import { NO_EFFORT_AUTO, PERMISSIVE_DEFERRED } from "@/engine/providers/_shared/effort-defaults.ts";
import { Auth } from "@/engine/providers/kimi/auth.ts";
import { composeKimiMessages } from "@/engine/providers/kimi/compose.ts";
import { fingerprint } from "@/engine/providers/kimi/fingerprint.ts";
import { kimiPromptAdapter } from "@/engine/providers/kimi/prompt-adapter.ts";
import { kimiStream } from "@/engine/providers/kimi/stream.ts";
import {
  translateRequestKimi as translateRequest,
  translateResponseKimi as translateResponse,
} from "@/engine/providers/kimi/translate.ts";
import { searchKimi } from "@/engine/tools/kimi.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";

const PROVIDER: ApiProvider<"anthropic-messages"> = {
  id: "kimi-code",
  api: "anthropic-messages",
  sourceId: "builtin",
  label: "Kimi",
  shortKey: "kimi",
};

export const MODELS: readonly ModelEntry[] = [
  {
    id: "kimi-for-coding",
    displayName: "K2.7 Code",
    contextWindow: 262_144,
    autoCompactTokenLimit: 229_144,
    provider: "kimi-code",
    efforts: [],
    defaultEffort: null,
  },
];

export const config: ProviderConfig<"anthropic-messages"> = {
  provider: PROVIDER,
  legacyModels: MODELS,
  auth: Auth,
  signupHint: "API key — kimi.com",
  fingerprint,
  translateRequest,
  translateResponse,
  stream: kimiStream,
  featureFlags: {
    fastMode: false,
    effortSuffix: false,
    thinkingSuffix: false,
    supportsImages: true,
  },
  defaultModelId: "kimi-for-coding",
  fallbackEfforts: NO_EFFORT_AUTO,
  deferredOverrides: PERMISSIVE_DEFERRED,
  promptAdapter: kimiPromptAdapter,
  recoverableError: (err, _ctx, attempt) => classifyProviderError(err, { attempt: attempt ?? 1 }),
  webSearch: searchKimi,
  usageDetails: { sourceLabel: "API key" },
  beginLogin: { kind: "api_key" },
  composeMessages: composeKimiMessages,
};
