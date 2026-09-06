import type { AuthCredentials, AuthStrategy } from "@/engine/contract/types.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { loadFor, saveFor } from "@/kernel/storage/credentials.ts";

export interface ApiKeyAuthSpec {
  providerId: ProviderId;
  label: string;
  envCanonical: string;
  envVendor: string;
  captureExtra?: (apiKey: string) => Promise<void>;
}

export interface ApiKeyAuthHelpers {
  envApiKey(): string | null;
  currentApiKey(): Promise<string>;
  loginWithKey(apiKey: string): Promise<{ apiKey: string }>;
  Auth: AuthStrategy;
}

export function makeApiKeyAuth(spec: ApiKeyAuthSpec): ApiKeyAuthHelpers {
  const envApiKey = (): string | null => {
    const c = process.env[spec.envCanonical]?.trim();
    if (c) return c;
    const v = process.env[spec.envVendor]?.trim();
    if (v) return v;
    return null;
  };

  const currentApiKey = async (): Promise<string> => {
    const env = envApiKey();
    if (env) return env;
    const creds = (await loadFor(spec.providerId)) as { apiKey?: string } | null;
    if (!creds?.apiKey) {
      throw new Error(
        `no ${spec.label} API key found — set $${spec.envCanonical} or run \`otherside login --provider ${spec.providerId}\``,
      );
    }
    return creds.apiKey;
  };

  const loginWithKey = async (apiKey: string): Promise<{ apiKey: string }> => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error(`empty ${spec.label} API key rejected`);
    }
    const creds = { apiKey: trimmed };
    await saveFor(spec.providerId, creds);
    if (spec.captureExtra) await spec.captureExtra(trimmed);
    return creds;
  };

  const Auth: AuthStrategy = {
    async load(): Promise<AuthCredentials | null> {
      const env = envApiKey();
      if (env) return { kind: "api_key", raw: { apiKey: env } };
      const creds = await loadFor(spec.providerId);
      if (!creds) return null;
      return { kind: "api_key", raw: creds };
    },
    async refresh(creds: AuthCredentials): Promise<AuthCredentials> {
      return creds;
    },
    isExpired(_creds: AuthCredentials): boolean {
      return false;
    },
  };

  return { envApiKey, currentApiKey, loginWithKey, Auth };
}
