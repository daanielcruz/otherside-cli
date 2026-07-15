import type { ProviderId } from "@/kernel/config/provider-ids.ts";

const GEMINI_FAMILY: ReadonlySet<ProviderId> = new Set(["antigravity"]);

const ANTHROPIC_FAMILY: ReadonlySet<ProviderId> = new Set(["anthropic"]);

export function isGeminiFamily(provider: ProviderId | undefined): boolean {
  if (!provider) return false;
  return GEMINI_FAMILY.has(provider);
}

export function isAnthropicFamily(provider: ProviderId | undefined): boolean {
  if (!provider) return false;
  return ANTHROPIC_FAMILY.has(provider);
}
