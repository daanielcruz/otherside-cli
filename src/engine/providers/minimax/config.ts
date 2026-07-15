import type { ApiProvider, ProviderConfig } from "@/engine/contract/types.ts";
import type { ModelEntry } from "@/engine/model/catalog.ts";
import { NO_EFFORT_AUTO, PERMISSIVE_DEFERRED } from "@/engine/providers/_shared/effort-defaults.ts";
import { anthropicPromptAdapter } from "@/engine/providers/anthropic/prompt-adapter.ts";
import { composeKimiMessages } from "@/engine/providers/kimi/compose.ts";
import { Auth } from "@/engine/providers/minimax/auth.ts";
import { fingerprint } from "@/engine/providers/minimax/fingerprint.ts";
import { minimaxStream } from "@/engine/providers/minimax/stream.ts";
import {
  translateRequestMinimax as translateRequest,
  translateResponseMinimax as translateResponse,
} from "@/engine/providers/minimax/translate.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";

const PROVIDER: ApiProvider<"anthropic-messages"> = {
  id: "minimax",
  api: "anthropic-messages",
  sourceId: "builtin",
  label: "MiniMax",
  shortKey: "minimax",
};

const M3_CONTEXT_WINDOW = 1_000_000;
const M2_7_CONTEXT_WINDOW = 204_800;

export const MODELS: readonly ModelEntry[] = [
  {
    id: "minimax-m3",
    displayName: "MiniMax M3",
    contextWindow: M3_CONTEXT_WINDOW,
    autoCompactTokenLimit: 967_000,
    provider: "minimax",
    supports1m: true,
    efforts: [],
    defaultEffort: null,
  },
  {
    id: "minimax-m2.7",
    displayName: "MiniMax M2.7",
    contextWindow: M2_7_CONTEXT_WINDOW,
    autoCompactTokenLimit: 171_800,
    provider: "minimax",
    onDemand: true,
    efforts: [],
    defaultEffort: null,
  },
];

export const config: ProviderConfig<"anthropic-messages"> = {
  provider: PROVIDER,
  legacyModels: MODELS,
  auth: Auth,
  signupHint: "API key — platform.minimax.io",
  fingerprint,
  translateRequest,
  translateResponse,
  stream: minimaxStream,
  featureFlags: {
    fastMode: false,
    effortSuffix: false,
    thinkingSuffix: false,
    supportsImages: false,
  },
  defaultModelId: "minimax-m2.7",
  fallbackEfforts: NO_EFFORT_AUTO,
  deferredOverrides: PERMISSIVE_DEFERRED,
  promptAdapter: anthropicPromptAdapter,
  recoverableError: (err, _ctx, attempt) => classifyProviderError(err, { attempt: attempt ?? 1 }),
  usageDetails: { sourceLabel: "API key" },
  beginLogin: { kind: "api_key" },
  composeMessages: composeKimiMessages,
};
