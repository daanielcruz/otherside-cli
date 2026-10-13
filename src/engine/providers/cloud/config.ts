import type { ProviderConfig } from "@/engine/contract/types.ts";
import type { ModelEntry } from "@/engine/model/catalog.ts";
import { composeFlatMessages } from "@/engine/providers/_shared/compose-flat.ts";
import { PERMISSIVE_DEFERRED } from "@/engine/providers/_shared/effort-defaults.ts";
import { uaClaudeCode } from "@/engine/providers/anthropic/_infra/fingerprint.ts";
import { providerDisplayName } from "@/kernel/std/types/provider-ids.ts";
import { Auth, beginLogin, currentTokens } from "./auth.ts";
import { CLOUD_DEFAULT_EFFORT, CLOUD_MODEL_ID } from "./model.ts";
import { createAnthropicCloudAdapter } from "./session.ts";

export const MODELS: readonly ModelEntry[] = [
  {
    id: CLOUD_MODEL_ID,
    displayName: "Opus 5.5",
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 967_000,
    provider: "anthropic-cloud",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: CLOUD_DEFAULT_EFFORT,
  },
];

const environmentId = process.env.OTHERSIDE_CLOUD_ENVIRONMENT_ID?.trim();
const adapter = createAnthropicCloudAdapter({
  currentTokens,
  userAgent: uaClaudeCode(),
  ...(environmentId ? { environmentId } : {}),
});

export const config: ProviderConfig<"cloud-sessions"> = {
  provider: {
    id: "anthropic-cloud",
    api: "cloud-sessions",
    sourceId: "builtin",
    label: providerDisplayName("anthropic-cloud"),
    shortKey: "anthropic-cloud",
  },
  legacyModels: MODELS,
  auth: Auth,
  signupHint: "OAuth — Claude Code Cloud credits",
  fingerprint: () => ({
    userAgent: uaClaudeCode(),
    extraHeaders: {
      "anthropic-version": "2023-06-01",
      "anthropic-client-platform": "claude_code_cli",
    },
  }),
  ...adapter,
  featureFlags: {
    fastMode: false,
    thinkingSuffix: true,
    supportsImages: true,
  },
  defaultModelId: CLOUD_MODEL_ID,
  fallbackEfforts: {
    levels: ["low", "medium", "high", "xhigh", "max"],
    default: CLOUD_DEFAULT_EFFORT,
  },
  deferredOverrides: PERMISSIVE_DEFERRED,
  promptAdapter: {},
  usageDetails: { sourceLabel: "Anthropic Cloud" },
  beginLogin: { kind: "oauth_pkce", begin: beginLogin },
  composeMessages: composeFlatMessages,
  streamEmitsKeepalive: true,
  contentIdleTimeoutMs: 600_000,
};
