import type { AuthStrategy } from "@/engine/contract/types.ts";
import { buildOauthAuthStrategy } from "@/engine/providers/_shared/oauth/auth-strategy.ts";
import {
  generateState,
  type PkceFlowHandle,
  runPkceFlow,
} from "@/engine/providers/_shared/oauth/handle.ts";
import { generatePkce } from "@/engine/providers/_shared/pkce.ts";
import { openBrowser } from "@/kernel/std/browser.ts";
import { ProviderHttpError } from "@/kernel/std/types/error-meta.ts";
import { providerDisplayName } from "@/kernel/std/types/provider-ids.ts";
import { type AnthropicTokens, loadFor, saveFor } from "@/kernel/storage/credentials.ts";
import {
  CLIENT_ID,
  LOGIN_SCOPES,
  OAUTH_AUTHORIZE_URL,
  OAUTH_REDIRECT_URI,
  OAUTH_TOKEN_URL,
  REFRESH_SCOPES,
  UA_AXIOS,
} from "./fingerprint.ts";

const REFRESH_SAFETY_MARGIN_MS = 60_000;

interface TokenResponse {
  token_type: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_uuid: string;
  organization?: { uuid: string; name: string };
  account?: { uuid: string; email_address: string };
}

export type AnthropicLoginHandle = PkceFlowHandle<AnthropicTokens>;

function buildAuthorizeUrl(challenge: string, state: string, redirectUri: string): string {
  const u = new URL(OAUTH_AUTHORIZE_URL);
  u.searchParams.set("code", "true");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", LOGIN_SCOPES.join(" "));
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  return u.toString();
}

function tokensFromResponse(resp: TokenResponse): AnthropicTokens {
  return {
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token,
    expiresAt: Date.now() + resp.expires_in * 1000,
    scopes: resp.scope.split(/\s+/).filter(Boolean),
    ...(resp.account && {
      accountEmail: resp.account.email_address,
      accountUuid: resp.account.uuid,
    }),
    ...(resp.organization && {
      organizationName: resp.organization.name,
      organizationUuid: resp.organization.uuid,
    }),
  };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA_AXIOS,
    },
    body: JSON.stringify(body),
  });
}

class RefreshExchangeError extends Error {
  constructor(
    readonly status: number,
    readonly responseText: string,
  ) {
    super(`refresh exchange failed: HTTP ${status}: ${responseText}`);
  }
}

function tokensChanged(current: AnthropicTokens, prior: AnthropicTokens): boolean {
  return current.accessToken !== prior.accessToken || current.refreshToken !== prior.refreshToken;
}

function isInvalidGrantError(err: unknown): err is RefreshExchangeError {
  return (
    err instanceof RefreshExchangeError &&
    err.status === 400 &&
    /\binvalid_grant\b/i.test(err.responseText)
  );
}

export function createAnthropicOAuth(providerId: "anthropic" | "anthropic-cloud") {
  let activeRefreshPromise: Promise<AnthropicTokens> | null = null;

  async function exchangeCode(
    code: string,
    state: string,
    verifier: string,
    redirectUri: string,
  ): Promise<AnthropicTokens> {
    const resp = await postJson(OAUTH_TOKEN_URL, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`token exchange failed: HTTP ${resp.status}: ${text}`);
    }
    const tokens = tokensFromResponse((await resp.json()) as TokenResponse);
    await saveFor(providerId, tokens);
    return tokens;
  }

  async function refreshTokens(refreshToken: string): Promise<AnthropicTokens> {
    const resp = await postJson(OAUTH_TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: REFRESH_SCOPES.join(" "),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new RefreshExchangeError(resp.status, text);
    }
    const fresh = tokensFromResponse((await resp.json()) as TokenResponse);
    // Refresh grants can omit identity fields; retain this namespace's stored identity.
    const prior = await loadFor(providerId);
    const tokens: AnthropicTokens = { ...fresh };
    const accountUuid = fresh.accountUuid ?? prior?.accountUuid;
    const accountEmail = fresh.accountEmail ?? prior?.accountEmail;
    const organizationName = fresh.organizationName ?? prior?.organizationName;
    const organizationUuid = fresh.organizationUuid ?? prior?.organizationUuid;
    if (accountUuid) tokens.accountUuid = accountUuid;
    if (accountEmail) tokens.accountEmail = accountEmail;
    if (organizationName) tokens.organizationName = organizationName;
    if (organizationUuid) tokens.organizationUuid = organizationUuid;
    await saveFor(providerId, tokens);
    return tokens;
  }

  async function executeRefresh(
    prior: AnthropicTokens | undefined,
    opts?: { force?: boolean },
  ): Promise<AnthropicTokens> {
    try {
      const stored = await loadFor(providerId);
      if (!stored) {
        throw new Error(
          `no ${providerId} credentials — run \`otherside login --provider ${providerId}\``,
        );
      }
      // Another flow won the rotation race; do not reuse the single-use refresh token.
      if (prior && tokensChanged(stored, prior)) return stored;
      if (!opts?.force && stored.expiresAt - REFRESH_SAFETY_MARGIN_MS > Date.now()) return stored;

      try {
        return await refreshTokens(stored.refreshToken);
      } catch (err) {
        // A different process can rotate the token after our read. Adopt its stored winner.
        if (isInvalidGrantError(err)) {
          const reloaded = await loadFor(providerId);
          if (reloaded && tokensChanged(reloaded, stored)) return reloaded;
          throw new ProviderHttpError({
            provider: providerId,
            status: 401,
            body: err.responseText,
          });
        }
        throw err;
      }
    } finally {
      activeRefreshPromise = null;
    }
  }

  function runRefresh(
    prior?: AnthropicTokens,
    opts?: { force?: boolean },
  ): Promise<AnthropicTokens> {
    if (!activeRefreshPromise) activeRefreshPromise = executeRefresh(prior, opts);
    return activeRefreshPromise;
  }

  async function login(): Promise<AnthropicTokens> {
    const flow = await beginLogin();
    await openBrowser(flow.url);
    return flow.result;
  }

  async function beginLogin(): Promise<AnthropicLoginHandle> {
    return runPkceFlow<AnthropicTokens>({
      providerLabel: providerDisplayName(providerId),
      callbackPath: "/callback",
      portStart: 54545,
      portEnd: 54545 + 64,
      redirectUriHost: "localhost",
      buildAuthorizeUrl: ({ challenge, state, redirectUri }) =>
        buildAuthorizeUrl(challenge, state, redirectUri),
      exchange: ({ code, verifier, state, redirectUri }) =>
        exchangeCode(code, state, verifier, redirectUri),
    });
  }

  async function loginManual(pasted: string): Promise<AnthropicTokens> {
    const pkce = await generatePkce();
    const state = generateState();
    const url = buildAuthorizeUrl(pkce.challenge, state, OAUTH_REDIRECT_URI);
    await openBrowser(url);
    const trimmed = pasted.trim();
    const idx = trimmed.indexOf("#");
    if (idx <= 0 || idx === trimmed.length - 1) {
      throw new Error(`callback input must be \`<code>#<state>\`, got ${JSON.stringify(trimmed)}`);
    }
    const code = trimmed.slice(0, idx);
    const returnedState = trimmed.slice(idx + 1);
    if (returnedState !== state) {
      throw new Error(`state mismatch: sent ${state}, got ${returnedState}`);
    }
    return exchangeCode(code, returnedState, pkce.verifier, OAUTH_REDIRECT_URI);
  }

  const Auth: AuthStrategy = buildOauthAuthStrategy<AnthropicTokens>({
    providerId,
    refresh: (tokens) => runRefresh(tokens),
  });

  async function currentTokens(): Promise<AnthropicTokens> {
    let tokens = await loadFor(providerId);
    if (!tokens) {
      throw new Error(
        `no ${providerId} credentials — run \`otherside login --provider ${providerId}\``,
      );
    }
    if (tokens.expiresAt - REFRESH_SAFETY_MARGIN_MS <= Date.now()) {
      tokens = await runRefresh(tokens);
    }
    return tokens;
  }

  // Server-driven 401 recovery must bypass the local expiry margin.
  function forceRefreshTokens(prior?: AnthropicTokens): Promise<AnthropicTokens> {
    return runRefresh(prior, { force: true });
  }

  async function authorizationHeader(): Promise<string> {
    const tokens = await currentTokens();
    return `Bearer ${tokens.accessToken}`;
  }

  return {
    Auth,
    beginLogin,
    login,
    loginManual,
    currentTokens,
    forceRefreshTokens,
    authorizationHeader,
  };
}
