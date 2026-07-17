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
  id: "kimi",
  api: "anthropic-messages",
  sourceId: "builtin",
  label: "Kimi",
  shortKey: "kimi",
};

export const MODELS: readonly ModelEntry[] = [
  {
    id: "k3",
    displayName: "Kimi K3",
    // Kimi Code plans can cap this at 256K; Allegretto and above expose the full 1M.
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 967_000,
    provider: "kimi",
    efforts: ["max"],
    defaultEffort: "max",
  },
  {
    id: "kimi-for-coding",
    displayName: "K2.7 Code",
    contextWindow: 262_144,
    autoCompactTokenLimit: 229_144,
    provider: "kimi",
    efforts: [],
    defaultEffort: null,
  },
  {
    id: "kimi-for-coding-highspeed",
    displayName: "K2.7 Code HighSpeed",
    contextWindow: 262_144,
    autoCompactTokenLimit: 229_144,
    provider: "kimi",
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
  defaultModelId: "k3",
  fallbackEfforts: NO_EFFORT_AUTO,
  deferredOverrides: PERMISSIVE_DEFERRED,
  promptAdapter: kimiPromptAdapter,
  recoverableError: (err, ctx, attempt) =>
    classifyProviderError(err, {
      attempt: attempt ?? 1,
      provider: ctx.provider,
      model: ctx.model,
    }),
  webSearch: searchKimi,
  usageDetails: { sourceLabel: "API key" },
  beginLogin: { kind: "api_key" },
  composeMessages: composeKimiMessages,
};
