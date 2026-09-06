import type { AuthStrategy } from "@/engine/contract/types.ts";
import { buildOauthAuthStrategy } from "@/engine/providers/_shared/oauth/auth-strategy.ts";
import { type PkceFlowHandle, runPkceFlow } from "@/engine/providers/_shared/oauth/handle.ts";
import { openBrowser } from "@/kernel/std/browser.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import { type CodexTokens, loadFor, saveFor } from "@/kernel/storage/credentials.ts";
import {
  CALLBACK_PATH,
  CALLBACK_PORTS,
  CLIENT_ID,
  DEFAULT_PORT,
  OAUTH_AUTHORIZE_URL,
  OAUTH_TOKEN_URL,
  ORIGINATOR_HTTP,
  SCOPE,
  userAgent,
} from "./fingerprint.ts";

const REFRESH_SAFETY_MARGIN_MS = 5 * 60_000;

interface ExchangeResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
}

interface RefreshResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

class RefreshExchangeError extends Error {
  constructor(
    readonly status: number,
    readonly responseText: string,
  ) {
    super(`codex refresh ${status}: ${responseText}`);
  }
}

function tokensChanged(current: CodexTokens, prior: CodexTokens): boolean {
  return current.accessToken !== prior.accessToken || current.refreshToken !== prior.refreshToken;
}

function isRotatedRefreshTokenError(err: unknown): err is RefreshExchangeError {
  return (
    err instanceof RefreshExchangeError &&
    err.status === 400 &&
    /\b(?:invalid_grant|refresh_token_reused)\b/i.test(err.responseText)
  );
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  const seg = parts[1];
  if (!seg) return null;
  const padded = seg + "=".repeat((4 - (seg.length % 4)) % 4);
  try {
    const norm = padded.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(norm, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseJwtExp(jwt: string): number | null {
  const p = decodeJwtPayload(jwt);
  if (!p) return null;
  const exp = p.exp;
  if (typeof exp === "number") return Math.floor(exp);
  return null;
}

export function parseJwtAccountId(jwt: string): string | null {
  const p = decodeJwtPayload(jwt);
  if (!p) return null;
  const auth = p["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const aid = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof aid === "string") return aid;
  }
  return null;
}

/**
 * Build the authorize URL, byte-identical to the live ChatGPT Desktop wire.
 *
 * Key/value order matches the captured authorize exactly. `originStableId` is
 * the per-install surface id (persisted `installationId`, generate-once). The
 * `redirect_uri` MUST use an IdP-registered loopback port (see CALLBACK_PORTS);
 * any other port returns authorize_hydra_invalid_request.
 */
function buildAuthorizeUrl(
  challenge: string,
  state: string,
  redirectUri: string,
  originStableId: string,
): string {
  const u = new URL(OAUTH_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("id_token_add_organizations", "true");
  u.searchParams.set("codex_cli_simplified_flow", "true");
  u.searchParams.set("state", state);
  u.searchParams.set("originator", ORIGINATOR_HTTP);
  u.searchParams.set("source_surface_stable_id", originStableId);
  u.searchParams.set("codex_origin_stable_id", originStableId);
  u.searchParams.set("codex_streamlined_login", "true");
  return u.toString();
}

async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<ExchangeResponse> {
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", code);
  form.set("redirect_uri", redirectUri);
  form.set("client_id", CLIENT_ID);
  form.set("code_verifier", verifier);
  // Live exchange is form-urlencoded with minimal headers (no originator).
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "*/*",
    },
    body: form.toString(),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`codex token exchange ${resp.status}: ${t}`);
  }
  return (await resp.json()) as ExchangeResponse;
}

async function refreshOauth(refreshToken: string): Promise<RefreshResponse> {
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "*/*",
      "User-Agent": userAgent(),
      originator: ORIGINATOR_HTTP,
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new RefreshExchangeError(resp.status, t);
  }
  return (await resp.json()) as RefreshResponse;
}

function tokensFromExchange(resp: ExchangeResponse, prior?: CodexTokens): CodexTokens {
  const expS = parseJwtExp(resp.access_token) ?? 0;
  const expiresAt = expS * 1000;
  const accountId = parseJwtAccountId(resp.id_token) ?? undefined;
  const out: CodexTokens = {
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token,
    idToken: resp.id_token,
    expiresAt,
    scopes: SCOPE.split(/\s+/).filter(Boolean),
  };
  if (accountId) out.accountId = accountId;
  if (prior?.installationId) out.installationId = prior.installationId;
  if (prior?.windowId) out.windowId = prior.windowId;
  return out;
}

function applyRefresh(prior: CodexTokens, refreshed: RefreshResponse): CodexTokens {
  const next: CodexTokens = { ...prior };
  if (refreshed.access_token) {
    next.accessToken = refreshed.access_token;
    const exp = parseJwtExp(refreshed.access_token) ?? 0;
    next.expiresAt = exp * 1000;
  }
  if (refreshed.refresh_token) next.refreshToken = refreshed.refresh_token;
  if (refreshed.id_token) {
    next.idToken = refreshed.id_token;
    const aid = parseJwtAccountId(refreshed.id_token);
    if (aid) next.accountId = aid;
  }
  return next;
}

export async function ensureInstallationId(): Promise<{
  installationId: string;
  windowId: string;
}> {
  const cur = await loadFor("codex");
  if (cur?.installationId && cur?.windowId) {
    return { installationId: cur.installationId, windowId: cur.windowId };
  }
  const installationId = cur?.installationId ?? uuidv4();
  const windowId = cur?.windowId ?? uuidv4();
  if (cur) await saveFor("codex", { ...cur, installationId, windowId });
  return { installationId, windowId };
}

export async function login(): Promise<CodexTokens> {
  const flow = await beginLogin();
  await openBrowser(flow.url);
  return flow.result;
}

export type CodexLoginHandle = PkceFlowHandle<CodexTokens>;

export async function beginLogin(): Promise<CodexLoginHandle> {
  const prior = (await loadFor("codex")) ?? undefined;
  const originStableId = prior?.installationId ?? uuidv4();
  return runPkceFlow<CodexTokens>({
    providerLabel: "Codex",
    callbackPath: CALLBACK_PATH,
    portStart: DEFAULT_PORT,
    portEnd: DEFAULT_PORT + 32,
    // The OAuth client only registers these two loopback redirect URIs; any
    // other port is rejected by the IdP (authorize_hydra_invalid_request).
    ports: CALLBACK_PORTS,
    redirectUriHost: "localhost",
    // App-server uses a 64-byte PKCE verifier (86-char base64url).
    verifierBytes: 64,
    buildAuthorizeUrl: ({ challenge, state, redirectUri }) =>
      buildAuthorizeUrl(challenge, state, redirectUri, originStableId),
    exchange: async ({ code, verifier, redirectUri }) => {
      const exchanged = await exchangeCode(code, verifier, redirectUri);
      const next = tokensFromExchange(exchanged, prior);
      if (!next.installationId) next.installationId = originStableId;
      if (!next.windowId) next.windowId = uuidv4();
      await saveFor("codex", next);
      return next;
    },
  });
}

let activeRefreshPromise: Promise<CodexTokens> | null = null;

async function executeRefresh(
  prior?: CodexTokens,
  opts?: { force?: boolean },
): Promise<CodexTokens> {
  try {
    let tokens = await loadFor("codex");
    if (!tokens) {
      if (prior) {
        tokens = prior;
      } else {
        throw new Error("not logged in — run `otherside login --provider codex`");
      }
    }
    // A token pair written by another flow won the rotation race. Use it instead
    // of spending the single-use refresh token the caller originally observed.
    if (prior && tokensChanged(tokens, prior)) return tokens;
    if (!opts?.force && tokens.expiresAt - REFRESH_SAFETY_MARGIN_MS > Date.now()) {
      return tokens;
    }
    try {
      const refreshed = await refreshOauth(tokens.refreshToken);
      const next = applyRefresh(tokens, refreshed);
      await saveFor("codex", next);
      return next;
    } catch (err) {
      // ChatGPT reports a spent rotating refresh token as either standard
      // invalid_grant or refresh_token_reused. Another process may have
      // persisted its winning pair after our initial storage read; use it once.
      if (isRotatedRefreshTokenError(err)) {
        const reloaded = await loadFor("codex");
        if (reloaded && tokensChanged(reloaded, tokens)) return reloaded;
      }
      if (!opts?.force && tokens.expiresAt > Date.now()) {
        return tokens;
      }
      throw err;
    }
  } finally {
    activeRefreshPromise = null;
  }
}

function runRefresh(prior?: CodexTokens, opts?: { force?: boolean }): Promise<CodexTokens> {
  if (!activeRefreshPromise) {
    activeRefreshPromise = executeRefresh(prior, opts);
  }
  return activeRefreshPromise;
}

// Server-driven 401 recovery: the token looked valid locally but the server
// rejected it, so the expiry margin must not short-circuit the refresh.
export function forceRefreshTokens(prior?: CodexTokens): Promise<CodexTokens> {
  return runRefresh(prior, { force: true });
}

export const Auth: AuthStrategy = buildOauthAuthStrategy<CodexTokens>({
  providerId: "codex",
  refresh: async (prior) => {
    return runRefresh(prior);
  },
});

export async function currentTokens(): Promise<CodexTokens> {
  let tokens = await loadFor("codex");
  if (!tokens) {
    throw new Error("not logged in — run `otherside login --provider codex`");
  }
  if (tokens.expiresAt - REFRESH_SAFETY_MARGIN_MS <= Date.now()) {
    tokens = await runRefresh(tokens);
  }
  return tokens;
}
