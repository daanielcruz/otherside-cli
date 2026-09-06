import type { AuthStrategy } from "@/engine/contract/types.ts";
import { buildOauthAuthStrategy } from "@/engine/providers/_shared/oauth/auth-strategy.ts";
import {
  CLIENT_ID,
  clientHeaders,
  DEVICE_AUTH_URL,
  DEVICE_CODE_GRANT_TYPE,
  OAUTH_REFERRER,
  OAUTH_TOKEN_URL,
  SCOPE,
} from "@/engine/providers/xai/fingerprint.ts";
import { loadFor, saveFor, type XaiTokens } from "@/kernel/storage/credentials.ts";

const REFRESH_SAFETY_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_TTL_SEC = 3600;

// Device-code poll bounds (RFC 8628 §3.5). xAI returns `interval` (seconds), we
// floor it and add the spec's slow_down increment when asked to back off.
const DEVICE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_MIN_INTERVAL_MS = 1_000;
const DEVICE_SLOW_DOWN_INCREMENT_MS = 5_000;
const DEVICE_DEFAULT_EXPIRES_MS = 30 * 60 * 1000;
// The server code is valid ~30 min, but an abandoned login should not keep
// polling that long. Cap the poll at 5 min — a real device login completes well
// inside it; past it we time out so a stranded flow stops hitting the token endpoint.
const DEVICE_MAX_POLL_MS = 5 * 60 * 1000;
const DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface DeviceLoginHandle {
  url: string;
  message: string;
  result: Promise<XaiTokens>;
}

class RefreshExchangeError extends Error {
  constructor(
    readonly status: number,
    readonly responseText: string,
  ) {
    super(`xai token refresh ${status}: ${responseText}`);
  }
}

function tokensChanged(current: XaiTokens, prior: XaiTokens): boolean {
  return current.accessToken !== prior.accessToken || current.refreshToken !== prior.refreshToken;
}

function isInvalidGrantError(err: unknown): err is RefreshExchangeError {
  return (
    err instanceof RefreshExchangeError &&
    err.status === 400 &&
    /\binvalid_grant\b/i.test(err.responseText)
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
    return JSON.parse(Buffer.from(norm, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function jwtExpSeconds(jwt: string): number | null {
  const exp = decodeJwtPayload(jwt)?.exp;
  return typeof exp === "number" ? Math.floor(exp) : null;
}

function jwtSubject(jwt: string): string | null {
  const sub = decodeJwtPayload(jwt)?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : null;
}

// xAI does not always return expires_in; when it's absent, fall back to the
// access token's own `exp` claim, then to a conservative fixed TTL.
function expiryFromResponse(resp: TokenResponse): number {
  const claimExp = jwtExpSeconds(resp.access_token);
  if (claimExp) return claimExp * 1000;
  return Date.now() + (resp.expires_in ?? DEFAULT_TOKEN_TTL_SEC) * 1000;
}

function formHeaders(): Record<string, string> {
  return {
    ...clientHeaders(),
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "*/*",
  };
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const form = new URLSearchParams();
  form.set("client_id", CLIENT_ID);
  form.set("scope", SCOPE);
  form.set("referrer", OAUTH_REFERRER);
  const resp = await fetch(DEVICE_AUTH_URL, {
    method: "POST",
    headers: formHeaders(),
    body: form.toString(),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`xai device authorization ${resp.status}: ${t}`);
  }
  const json = (await resp.json()) as DeviceCodeResponse;
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("xai device response missing device_code / user_code / verification_uri");
  }
  return json;
}

function intervalMsFor(seconds: number | undefined): number {
  const ms =
    typeof seconds === "number" && seconds > 0 ? seconds * 1000 : DEVICE_DEFAULT_INTERVAL_MS;
  return Math.max(ms, DEVICE_MIN_INTERVAL_MS);
}

export function expiresMsFor(seconds: number | undefined): number {
  const serverMs =
    typeof seconds === "number" && seconds > 0 ? seconds * 1000 : DEVICE_DEFAULT_EXPIRES_MS;
  return Math.min(serverMs, DEVICE_MAX_POLL_MS);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pollDeviceToken(device: DeviceCodeResponse): Promise<TokenResponse> {
  const deadline = Date.now() + expiresMsFor(device.expires_in);
  let intervalMs = intervalMsFor(device.interval);

  while (Date.now() < deadline) {
    const form = new URLSearchParams();
    form.set("grant_type", DEVICE_CODE_GRANT_TYPE);
    form.set("device_code", device.device_code);
    form.set("client_id", CLIENT_ID);
    const resp = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: formHeaders(),
      body: form.toString(),
    });
    if (resp.ok) return (await resp.json()) as TokenResponse;

    const body = (await resp.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };
    const remaining = Math.max(0, deadline - Date.now());
    if (body.error === "authorization_pending") {
      await sleep(Math.min(intervalMs + DEVICE_POLL_SAFETY_MARGIN_MS, remaining));
      continue;
    }
    if (body.error === "slow_down") {
      intervalMs += DEVICE_SLOW_DOWN_INCREMENT_MS;
      await sleep(Math.min(intervalMs + DEVICE_POLL_SAFETY_MARGIN_MS, remaining));
      continue;
    }
    if (body.error === "access_denied" || body.error === "authorization_denied") {
      throw new Error("xai device authorization was denied");
    }
    if (body.error === "expired_token") {
      throw new Error("xai device code expired — re-run `otherside login --provider xai`");
    }
    const detail = body.error_description ?? body.error ?? "";
    throw new Error(`xai device token exchange ${resp.status}${detail ? `: ${detail}` : ""}`);
  }
  throw new Error("xai device login timed out — re-run `otherside login --provider xai`");
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set("client_id", CLIENT_ID);
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: formHeaders(),
    body: form.toString(),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new RefreshExchangeError(resp.status, t);
  }
  return (await resp.json()) as TokenResponse;
}

function tokensFromResponse(resp: TokenResponse, prior?: XaiTokens): XaiTokens {
  const out: XaiTokens = {
    accessToken: resp.access_token,
    // xAI rotates the refresh token on every grant; keep the new one, but fall
    // back to the prior value if a refresh response omits it.
    refreshToken: resp.refresh_token || prior?.refreshToken || "",
    expiresAt: expiryFromResponse(resp),
    scopes: SCOPE.split(/\s+/).filter(Boolean),
  };
  if (resp.id_token) {
    out.idToken = resp.id_token;
    const sub = jwtSubject(resp.id_token);
    if (sub) out.accountId = sub;
  } else if (prior?.accountId) {
    out.accountId = prior.accountId;
  }
  return out;
}

// Single-flight refresh: xAI consumes the presented refresh token and issues a
// rotated one, so two concurrent refreshes from the same stored token would
// leave one caller holding an already-invalidated token. Collapse them onto a
// single HTTP call.
let refreshInFlight: Promise<XaiTokens> | null = null;

async function executeRefresh(prior?: XaiTokens, opts?: { force?: boolean }): Promise<XaiTokens> {
  try {
    const stored = await loadFor("xai");
    if (!stored) {
      throw new Error("not logged in — run `otherside login --provider xai`");
    }
    // A token pair written by another flow won the rotation race. Use it instead
    // of spending the single-use refresh token the caller originally observed.
    if (prior && tokensChanged(stored, prior)) return stored;
    if (!opts?.force && stored.expiresAt - REFRESH_SAFETY_MARGIN_MS > Date.now()) {
      return stored;
    }
    try {
      const refreshed = await refreshTokens(stored.refreshToken);
      const next = tokensFromResponse(refreshed, stored);
      await saveFor("xai", next);
      return next;
    } catch (err) {
      // A different process can win the rotating-refresh race after our initial
      // storage read. Reload once and continue with its persisted token pair.
      if (isInvalidGrantError(err)) {
        const reloaded = await loadFor("xai");
        if (reloaded && tokensChanged(reloaded, stored)) return reloaded;
      }
      throw err;
    }
  } finally {
    refreshInFlight = null;
  }
}

function runRefresh(prior?: XaiTokens, opts?: { force?: boolean }): Promise<XaiTokens> {
  if (!refreshInFlight) refreshInFlight = executeRefresh(prior, opts);
  return refreshInFlight;
}

// Server-driven 401 recovery: the token looked valid locally but the server
// rejected it, so the expiry margin must not short-circuit the refresh.
export function forceRefreshTokens(prior?: XaiTokens): Promise<XaiTokens> {
  return runRefresh(prior, { force: true });
}

export async function beginLogin(): Promise<DeviceLoginHandle> {
  const device = await requestDeviceCode();
  const result = (async (): Promise<XaiTokens> => {
    const exchanged = await pollDeviceToken(device);
    const prior = (await loadFor("xai")) ?? undefined;
    const next = tokensFromResponse(exchanged, prior);
    await saveFor("xai", next);
    return next;
  })();
  return {
    url: device.verification_uri_complete ?? device.verification_uri,
    message: `Open ${device.verification_uri} on any device and enter code: ${device.user_code}`,
    result,
  };
}

export async function login(): Promise<XaiTokens> {
  const flow = await beginLogin();
  return flow.result;
}

export const Auth: AuthStrategy = buildOauthAuthStrategy<XaiTokens>({
  providerId: "xai",
  refresh: async (prior) => runRefresh(prior),
});

export async function currentTokens(): Promise<XaiTokens> {
  const tokens = await loadFor("xai");
  if (!tokens) {
    throw new Error("not logged in — run `otherside login --provider xai`");
  }
  if (tokens.expiresAt - REFRESH_SAFETY_MARGIN_MS <= Date.now()) {
    return runRefresh(tokens);
  }
  return tokens;
}
