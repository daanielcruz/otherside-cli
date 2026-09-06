export const PROVIDER_ID_VALUES = [
  "anthropic",
  "antigravity",
  "codex",
  "deepseek",
  "glm",
  "xai",
  "kimi",
  "minimax",
  "openai",
] as const;

export type ProviderId = (typeof PROVIDER_ID_VALUES)[number];

export const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  antigravity: "Antigravity",
  codex: "Codex",
  deepseek: "DeepSeek",
  glm: "Z.AI",
  xai: "xAI",
  kimi: "Kimi",
  minimax: "MiniMax",
  openai: "OpenAI Custom",
} as const satisfies Record<ProviderId, string>;

/** Formatted display name; never the raw slug id. */
export function providerDisplayName(provider: ProviderId): string {
  return PROVIDER_LABELS[provider];
}

/** Canonical identity of one concrete model route; a model never exists outside its provider. */
export interface ProviderModelRoute {
  provider: ProviderId;
  model: string;
}

export function modelRoute(provider: ProviderId, model: string): ProviderModelRoute {
  return { provider, model };
}

export const IMAGE_GENERATOR_PROVIDER_ID_VALUES = ["codex", "xai", "antigravity"] as const;
export type ImageGeneratorProviderId = (typeof IMAGE_GENERATOR_PROVIDER_ID_VALUES)[number];
export type ImageGeneratorSelection = "off" | ImageGeneratorProviderId;

export const VOICE_PROVIDER_ID_VALUES = ["anthropic", "codex", "xai", "antigravity"] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDER_ID_VALUES)[number];
export type VoiceProviderSelection = "off" | VoiceProviderId;

const PROVIDER_ID_SET: ReadonlySet<string> = new Set(PROVIDER_ID_VALUES);
const IMAGE_GENERATOR_PROVIDER_ID_SET: ReadonlySet<string> = new Set(
  IMAGE_GENERATOR_PROVIDER_ID_VALUES,
);
const VOICE_PROVIDER_ID_SET: ReadonlySet<string> = new Set(VOICE_PROVIDER_ID_VALUES);

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_ID_SET.has(value);
}

export function isImageGeneratorProviderId(value: unknown): value is ImageGeneratorProviderId {
  return typeof value === "string" && IMAGE_GENERATOR_PROVIDER_ID_SET.has(value);
}

export function isImageGeneratorSelection(value: unknown): value is ImageGeneratorSelection {
  return value === "off" || isImageGeneratorProviderId(value);
}

export function isVoiceProviderId(value: unknown): value is VoiceProviderId {
  return typeof value === "string" && VOICE_PROVIDER_ID_SET.has(value);
}

export function isVoiceProviderSelection(value: unknown): value is VoiceProviderSelection {
  return value === "off" || isVoiceProviderId(value);
}
