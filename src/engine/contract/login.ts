import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { deleteFor } from "@/kernel/storage/credentials.ts";

export type ValidationIntent = "verify" | "change_auth" | "cancel";

export type ValidationHandler = (
  validationUrl: string,
  description: string,
) => Promise<ValidationIntent>;

export type FinalizeLoginResult = "ok" | "change_auth";

export interface OAuthHandle {
  url: string;
  result: Promise<unknown>;
  submitCode?: (pasted: string) => void;
  message?: string;
}

export type LoginFlow =
  | {
      kind: "oauth_pkce";
      begin: () => Promise<OAuthHandle>;
      finalizeLogin?: (opts: { onValidation: ValidationHandler }) => Promise<FinalizeLoginResult>;
    }
  | { kind: "oauth_redirect_only"; login: () => Promise<unknown> }
  | { kind: "api_key" }
  | { kind: "openai_custom" };

export function normalizeLoginProvider(input: string | null): ProviderId | null {
  const provider = input?.trim().toLowerCase();
  if (!provider) return null;
  if (provider === "anthropic") return "anthropic";
  if (provider === "codex") return "codex";
  if (provider === "grok" || provider === "xai") return "xai";
  if (provider === "antigravity") return "antigravity";
  if (provider === "kimi-code") return "kimi-code";
  if (provider === "deepseek") return "deepseek";
  if (provider === "minimax") return "minimax";
  if (provider === "glm") return "glm";
  if (provider === "openai-custom") return "openai-custom";
  return null;
}

export async function runLogout(providerInput: string | null): Promise<string[]> {
  const provider = normalizeLoginProvider(providerInput);
  if (!provider) {
    throw new Error(
      `unknown provider ${JSON.stringify(providerInput)} — use anthropic, codex, xai, kimi-code, minimax, glm, antigravity, deepseek, or openai-custom`,
    );
  }
  await deleteFor(provider);
  return [`Cleared cached credentials for ${provider}.`];
}
