export const PROVIDER_ID_VALUES = [
  "anthropic",
  "antigravity",
  "codex",
  "deepseek",
  "glm",
  "xai",
  "kimi-code",
  "minimax",
  "openai-custom",
] as const;

export type ProviderId = (typeof PROVIDER_ID_VALUES)[number];

const PROVIDER_ID_SET: ReadonlySet<string> = new Set(PROVIDER_ID_VALUES);

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_ID_SET.has(value);
}
