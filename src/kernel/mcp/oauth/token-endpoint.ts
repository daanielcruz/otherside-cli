import type { OAuthClientCredentials, OAuthToken } from "./token-store.ts";

const TOKEN_TIMEOUT_MS = 15_000;
const ERROR_BODY_CLIP = 200;

export interface TokenExchangeRequest {
  tokenEndpoint: string;
  client: OAuthClientCredentials;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource?: string;
}

export interface TokenRefreshRequest {
  tokenEndpoint: string;
  client: OAuthClientCredentials;
  refreshToken: string;
  resource?: string;
  scope?: string;
}

export class InvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGrantError";
  }
}

export async function exchangeAuthorizationCode(req: TokenExchangeRequest): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: req.code,
    redirect_uri: req.redirectUri,
    client_id: req.client.clientId,
    code_verifier: req.codeVerifier,
  });
  if (req.resource) body.set("resource", req.resource);
  if (req.client.clientSecret) body.set("client_secret", req.client.clientSecret);
  return postTokenRequest(req.tokenEndpoint, body);
}

export async function refreshAccessToken(req: TokenRefreshRequest): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: req.refreshToken,
    client_id: req.client.clientId,
  });
  if (req.resource) body.set("resource", req.resource);
  if (req.scope) body.set("scope", req.scope);
  if (req.client.clientSecret) body.set("client_secret", req.client.clientSecret);
  const refreshed = await postTokenRequest(req.tokenEndpoint, body);
  if (!refreshed.refreshToken) refreshed.refreshToken = req.refreshToken;
  return refreshed;
}

async function postTokenRequest(endpoint: string, body: URLSearchParams): Promise<OAuthToken> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await safeReadText(res);
    if (isInvalidGrant(text)) {
      throw new InvalidGrantError(`token endpoint rejected grant: ${clip(text)}`);
    }
    throw new Error(`token endpoint HTTP ${res.status}: ${clip(text)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return toToken(data);
}

function toToken(data: Record<string, unknown>): OAuthToken {
  const accessToken = typeof data.access_token === "string" ? data.access_token : null;
  if (!accessToken) throw new Error("token response missing access_token");
  const tokenType = typeof data.token_type === "string" ? data.token_type : "Bearer";
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : null;
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : undefined;
  const scope = typeof data.scope === "string" ? data.scope : undefined;
  const obtainedAt = Date.now();
  const expiresAt = expiresIn !== null ? obtainedAt + expiresIn * 1000 : undefined;
  return {
    accessToken,
    tokenType,
    obtainedAt,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function isInvalidGrant(text: string): boolean {
  return /"error"\s*:\s*"invalid_grant"/.test(text);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function clip(text: string): string {
  return text.length <= ERROR_BODY_CLIP ? text : `${text.slice(0, ERROR_BODY_CLIP)}…`;
}
