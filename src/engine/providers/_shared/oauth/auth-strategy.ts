import type { AuthCredentials, AuthStrategy } from "@/engine/contract/types.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { loadFor } from "@/kernel/storage/credentials.ts";

export interface OauthTokenLike {
  expiresAt: number;
}

export interface OauthAuthStrategySpec<TTokens extends OauthTokenLike> {
  providerId: ProviderId;
  refresh(tokens: TTokens): Promise<TTokens>;
  marginMs?: number;
}

const DEFAULT_REFRESH_MARGIN_MS = 60_000;

export function buildOauthAuthStrategy<TTokens extends OauthTokenLike>(
  spec: OauthAuthStrategySpec<TTokens>,
): AuthStrategy {
  const margin = spec.marginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  return {
    async load(): Promise<AuthCredentials | null> {
      const tokens = (await loadFor(spec.providerId)) as TTokens | null;
      if (!tokens) return null;
      return { kind: "oauth", expiresAt: tokens.expiresAt, raw: tokens };
    },
    async refresh(creds: AuthCredentials): Promise<AuthCredentials> {
      const next = await spec.refresh(creds.raw as TTokens);
      return { kind: "oauth", expiresAt: next.expiresAt, raw: next };
    },
    isExpired(creds: AuthCredentials): boolean {
      return (creds.raw as TTokens).expiresAt - margin <= Date.now();
    },
  };
}
