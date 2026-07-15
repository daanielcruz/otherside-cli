import type { ApiProvider, ProviderConfig } from "@/engine/contract/types.ts";
import type { ModelEntry } from "@/engine/model/catalog.ts";
import { composeFlatMessages } from "@/engine/providers/_shared/compose-flat.ts";
import { NO_EFFORT_AUTO, PERMISSIVE_DEFERRED } from "@/engine/providers/_shared/effort-defaults.ts";
import { Auth, beginLogin, finalizeLogin } from "@/engine/providers/antigravity/auth.ts";
import { recoverableError } from "@/engine/providers/antigravity/fallback.ts";
import { fingerprint } from "@/engine/providers/antigravity/fingerprint.ts";
import { antigravityPromptAdapter } from "@/engine/providers/antigravity/prompt-adapter.ts";
import { antigravityStream } from "@/engine/providers/antigravity/stream.ts";
import {
  translateRequestAntigravity,
  translateResponseAntigravity,
} from "@/engine/providers/antigravity/translate.ts";
import { searchAntigravity } from "@/engine/tools/antigravity.ts";

const PROVIDER: ApiProvider<"anthropic-messages"> = {
  id: "antigravity",
  api: "anthropic-messages",
  sourceId: "builtin",
  label: "Antigravity",
  shortKey: "antigravity",
};

const GEMINI_CONTEXT_WINDOW = 1_048_576;
const CLAUDE_CONTEXT_WINDOW = 200_000;
const GPT_OSS_CONTEXT_WINDOW = 131_072;

export const MODELS: readonly ModelEntry[] = [
  {
    id: "gemini-3-flash",
    displayName: "Gemini 3.5 Flash (High)",
    contextWindow: GEMINI_CONTEXT_WINDOW,
    autoCompactTokenLimit: 1_015_576,
    provider: "antigravity",
    supports1m: true,
    efforts: [],
    defaultEffort: null,
  },
  {
    id: "gemini-3-flash-medium",
    displayName: "Gemini 3.5 Flash (Medium)",
    contextWindow: GEMINI_CONTEXT_WINDOW,
    autoCompactTokenLimit: 1_015_576,
    provider: "antigravity",
    supports1m: true,
    efforts: [],
    defaultEffort: null,
  },
  {
    id: "gemini-3-flash-low",
    displayName: "Gemini 3.5 Flash (Low)",
    contextWindow: GEMINI_CONTEXT_WINDOW,
    autoCompactTokenLimit: 1_015_576,
    provider: "antigravity",
    supports1m: true,
    efforts: [],
    defaultEffort: null,
  },
  {
    id: "gemini-3.1-pro-high",
    displayName: "Gemini 3.1 Pro (High)",
    contextWindow: GEMINI_CONTEXT_WINDOW,
    autoCompactTokenLimit: 1_015_576,
    provider: "antigravity",
    supports1m: true,
    efforts: [],
    defaultEffort: null,
  },
  {
    id: "gemini-3.1-pro-low",
    displayName: "Gemini 3.1 Pro (Low)",
    contextWindow: GEMINI_CONTEXT_WINDOW,
    autoCompactTokenLimit: 1_015_576,
    provider: "antigravity",
    supports1m: true,
    efforts: [],
    defaultEffort: null,
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6 (Thinking)",
    contextWindow: CLAUDE_CONTEXT_WINDOW,
    autoCompactTokenLimit: 167_000,
    provider: "antigravity",
    onDemand: true,
    supports1m: false,
    efforts: [],
    defaultEffort: null,
  },
  {
    id: "claude-opus-4-6-thinking",
    displayName: "Claude Opus 4.6 (Thinking)",
    contextWindow: CLAUDE_CONTEXT_WINDOW,
    autoCompactTokenLimit: 167_000,
    provider: "antigravity",
    onDemand: true,
    supports1m: false,
    efforts: [],
    defaultEffort: null,
  },
  {
    id: "gpt-oss-120b-medium",
    displayName: "GPT-OSS 120B (Medium)",
    contextWindow: GPT_OSS_CONTEXT_WINDOW,
    autoCompactTokenLimit: 98_072,
    provider: "antigravity",
    onDemand: true,
    supports1m: false,
    efforts: [],
    defaultEffort: null,
  },
];

export const config: ProviderConfig<"anthropic-messages"> = {
  provider: PROVIDER,
  legacyModels: MODELS,
  auth: Auth,
  signupHint: "OAuth — Google (Antigravity / CloudCode)",
  fingerprint,
  translateRequest: translateRequestAntigravity,
  translateResponse: translateResponseAntigravity,
  stream: antigravityStream,
  featureFlags: {
    fastMode: false,
    effortSuffix: false,
    thinkingSuffix: false,
    supportsImages: true,
  },
  defaultModelId: "gemini-3-flash",
  fallbackEfforts: NO_EFFORT_AUTO,
  allowsCustomModel: true,
  deferredOverrides: PERMISSIVE_DEFERRED,
  promptAdapter: antigravityPromptAdapter,
  recoverableError,
  webSearch: searchAntigravity,
  usageDetails: { sourceLabel: "Antigravity OAuth" },
  beginLogin: { kind: "oauth_pkce", begin: beginLogin, finalizeLogin },
  composeMessages: composeFlatMessages,
};
