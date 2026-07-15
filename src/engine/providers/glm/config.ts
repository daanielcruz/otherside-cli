import type { ApiProvider, ProviderConfig } from "@/engine/contract/types.ts";
import type { ModelEntry } from "@/engine/model/catalog.ts";
import { NO_EFFORT_AUTO, PERMISSIVE_DEFERRED } from "@/engine/providers/_shared/effort-defaults.ts";
import { anthropicPromptAdapter } from "@/engine/providers/anthropic/prompt-adapter.ts";
import { Auth, beginLogin } from "@/engine/providers/glm/auth.ts";
import { composeGlmMessages } from "@/engine/providers/glm/compose.ts";
import { fingerprint } from "@/engine/providers/glm/fingerprint.ts";
import { glmStream } from "@/engine/providers/glm/stream.ts";
import {
  translateRequestGlm as translateRequest,
  translateResponseGlm as translateResponse,
} from "@/engine/providers/glm/translate.ts";
import { searchGlm } from "@/engine/tools/glm.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";

const PROVIDER: ApiProvider<"anthropic-messages"> = {
  id: "glm",
  api: "anthropic-messages",
  sourceId: "builtin",
  label: "Z.AI",
  shortKey: "glm",
};

const GLM_5_2_CONTEXT_WINDOW = 1_000_000;
const GLM_5_TURBO_CONTEXT_WINDOW = 200_000;

const GLM_5_EFFORTS: EffortLevel[] = ["high", "max"];
const GLM_5_DEFAULT_EFFORT: EffortLevel = "max";

export const MODELS: readonly ModelEntry[] = [
  {
    id: "glm-5.2",
    displayName: "GLM-5.2",
    contextWindow: GLM_5_2_CONTEXT_WINDOW,
    autoCompactTokenLimit: 967_000,
    provider: "glm",
    efforts: GLM_5_EFFORTS,
    defaultEffort: GLM_5_DEFAULT_EFFORT,
  },
  {
    id: "glm-5-turbo",
    displayName: "GLM-5-Turbo",
    contextWindow: GLM_5_TURBO_CONTEXT_WINDOW,
    autoCompactTokenLimit: 167_000,
    provider: "glm",
    efforts: [],
    defaultEffort: null,
  },
];

export const config: ProviderConfig<"anthropic-messages"> = {
  provider: PROVIDER,
  legacyModels: MODELS,
  auth: Auth,
  signupHint: "OAuth — chat.z.ai",
  fingerprint,
  translateRequest,
  translateResponse,
  stream: glmStream,
  featureFlags: {
    fastMode: false,
    effortSuffix: false,
    thinkingSuffix: true,
    supportsImages: true,
  },
  defaultModelId: "glm-5.2",
  allowsCustomModel: false,
  fallbackEfforts: NO_EFFORT_AUTO,
  deferredOverrides: PERMISSIVE_DEFERRED,
  promptAdapter: anthropicPromptAdapter,
  recoverableError: (err, _ctx, attempt) => classifyProviderError(err, { attempt: attempt ?? 1 }),
  usageDetails: { sourceLabel: "OAuth" },
  beginLogin: { kind: "oauth_pkce", begin: beginLogin },
  composeMessages: composeGlmMessages,
  webSearch: searchGlm,
};
