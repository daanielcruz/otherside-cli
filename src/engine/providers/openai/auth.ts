import type { AuthCredentials, AuthStrategy } from "@/engine/contract/types.ts";
import { loadFor, type OpenAiCustomCreds, saveFor } from "@/kernel/storage/credentials.ts";
import { DEFAULT_BASE_URL } from "./fingerprint.ts";

const ENV_API_KEY_CANONICAL = "OTHERSIDE_OPENAI_API_KEY";
const ENV_API_KEY_VENDOR = "OPENAI_API_KEY";
const ENV_BASE_URL = "OTHERSIDE_OPENAI_BASE_URL";

export interface ResolvedConfig {
  apiKey: string | null;
  baseUrl: string;
  model?: string;
  contextWindow?: number;
  outputTokenLimit?: number;
}

function envApiKey(): string | null {
  const canonicalKey = process.env[ENV_API_KEY_CANONICAL]?.trim();
  if (canonicalKey) return canonicalKey;
  const vendorKey = process.env[ENV_API_KEY_VENDOR]?.trim();
  if (vendorKey) return vendorKey;
  return null;
}

function envBaseUrl(): string | null {
  const baseUrl = process.env[ENV_BASE_URL]?.trim();
  return baseUrl ? baseUrl : null;
}

export async function currentConfig(): Promise<ResolvedConfig> {
  const stored = await loadFor("openai");
  const apiKey = stored ? (stored.apiKey ?? "") : envApiKey();
  const baseUrl = stored?.baseUrl || envBaseUrl() || DEFAULT_BASE_URL;
  return {
    apiKey,
    baseUrl,
    ...(stored?.model ? { model: stored.model } : {}),
    ...(stored?.contextWindow ? { contextWindow: stored.contextWindow } : {}),
    ...(stored?.outputTokenLimit ? { outputTokenLimit: stored.outputTokenLimit } : {}),
  };
}

export async function loginWithConfig(
  apiKey: string | null,
  baseUrl: string,
  model?: string,
  contextWindow?: number,
  outputTokenLimit?: number,
): Promise<OpenAiCustomCreds> {
  const trimmedKey = apiKey?.trim() ?? "";
  const trimmedBase = baseUrl.trim();
  const trimmedModel = model?.trim() ?? "";
  if (!trimmedBase) {
    throw new Error("openai requires baseUrl");
  }
  const creds: OpenAiCustomCreds =
    trimmedModel.length > 0
      ? {
          apiKey: trimmedKey,
          baseUrl: trimmedBase,
          model: trimmedModel,
          ...(contextWindow ? { contextWindow } : {}),
          ...(outputTokenLimit ? { outputTokenLimit } : {}),
        }
      : {
          apiKey: trimmedKey,
          baseUrl: trimmedBase,
          ...(outputTokenLimit ? { outputTokenLimit } : {}),
        };
  await saveFor("openai", creds);
  return creds;
}

export const Auth: AuthStrategy = {
  async load(): Promise<AuthCredentials | null> {
    const cfg = await currentConfig();
    if (!cfg.apiKey && !envBaseUrl() && !(await loadFor("openai"))) return null;
    return { kind: "api_key", raw: cfg };
  },
  async refresh(creds: AuthCredentials): Promise<AuthCredentials> {
    return creds;
  },
  isExpired(_creds: AuthCredentials): boolean {
    return false;
  },
};
