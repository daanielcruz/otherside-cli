import { existsSync, readFileSync } from "node:fs";
import { CortexApiError, cortexFetch } from "@/backend/shared/cortex.ts";
import { authPath, ensureRemoteHome } from "@/backend/shared/paths.ts";
import { refreshSocketAuth } from "@/backend/shared/realtime.ts";
import { withFileLock } from "@/kernel/std/fs/file-lock.ts";
import { atomicWriteFileSync } from "@/kernel/std/fs/secure-fs.ts";

const FILE_MODE = 0o600;
const EXPIRY_LEAD_SECONDS = 600;
const REFRESH_BACKOFF_MS = 30_000;
const REFRESH_REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_LOCK_MAX_WAIT_MS = 40_000;
const REFRESH_LOCK_STALE_AFTER_MS = 60_000;
const REFRESH_LOCK_UPDATE_MS = 5_000;

let nextRefreshAttempt = 0;
let socketAccessToken: string | null = null;

export const AUTH_SCOPES = ["full", "device"] as const;
export type AuthScope = (typeof AUTH_SCOPES)[number];

const AUTH_SCOPE_SET: ReadonlySet<string> = new Set(AUTH_SCOPES);

export interface RemoteAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface AccessTokenClaims {
  sub?: string;
  email?: string;
  scp?: string;
}

interface StoredAuth {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

function toStored(auth: RemoteAuth): StoredAuth {
  return {
    access_token: auth.accessToken,
    refresh_token: auth.refreshToken,
    expires_at: auth.expiresAt,
  };
}

function fromStored(stored: StoredAuth): RemoteAuth {
  return {
    accessToken: stored.access_token,
    refreshToken: stored.refresh_token,
    expiresAt: stored.expires_at,
  };
}

export function loadAuth(): RemoteAuth | null {
  const path = authPath();
  if (!existsSync(path)) return null;
  try {
    return fromStored(JSON.parse(readFileSync(path, "utf8")) as StoredAuth);
  } catch {
    return null;
  }
}

function decodeAccessTokenClaims(accessToken: string): AccessTokenClaims {
  const parts = accessToken.split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
    ) as AccessTokenClaims;
  } catch {
    return {};
  }
}

export function decodeUserId(accessToken: string): string {
  return decodeAccessTokenClaims(accessToken).sub ?? "";
}

export function currentUserId(): string | null {
  const auth = loadAuth();
  if (!auth) return null;
  const id = decodeUserId(auth.accessToken);
  return id.length > 0 ? id : null;
}

export function decodeUserEmail(accessToken: string): string {
  return decodeAccessTokenClaims(accessToken).email ?? "";
}

export function currentUserEmail(): string | null {
  const auth = loadAuth();
  if (!auth) return null;
  const email = decodeUserEmail(auth.accessToken);
  return email.length > 0 ? email : null;
}

export function decodeAuthScope(accessToken: string): AuthScope {
  const scope = decodeAccessTokenClaims(accessToken).scp;
  return typeof scope === "string" && AUTH_SCOPE_SET.has(scope) ? (scope as AuthScope) : "full";
}

export function currentAuthScope(): AuthScope | null {
  const auth = loadAuth();
  return auth ? decodeAuthScope(auth.accessToken) : null;
}

export function saveAuth(auth: RemoteAuth): void {
  ensureRemoteHome();
  atomicWriteFileSync(authPath(), JSON.stringify(toStored(auth), null, 2), FILE_MODE);
}

export function clearAuth(): void {
  const auth = loadAuth();
  if (auth) void revokeStoredCredential(auth).catch(() => {});
  clearLocalAuth();
}

export async function revokeAndClearAuth(): Promise<void> {
  const auth = loadAuth();
  try {
    if (auth) await revokeStoredCredential(auth);
  } catch {
    // Local sign-out must remain available while the backend is unreachable.
  } finally {
    clearLocalAuth();
  }
}

async function revokeStoredCredential(auth: RemoteAuth): Promise<void> {
  if (decodeAuthScope(auth.accessToken) === "device") {
    await cortexFetch("/v1/auth/device/revoke", {
      method: "POST",
      token: auth.accessToken,
      body: {},
    });
    return;
  }
  await cortexFetch("/v1/auth/logout", {
    method: "POST",
    token: auth.accessToken,
    body: { scope: "local" },
  });
}

function clearLocalAuth(): void {
  socketAccessToken = null;
  nextRefreshAttempt = 0;
  if (existsSync(authPath())) atomicWriteFileSync(authPath(), "", FILE_MODE);
}

export function isExpired(auth: RemoteAuth, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!auth.expiresAt) return true;
  return auth.expiresAt - EXPIRY_LEAD_SECONDS <= nowSeconds;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at?: number | string;
  expires_in?: number;
}

function expiresAtSeconds(body: TokenResponse, nowSeconds = Math.floor(Date.now() / 1000)): number {
  if (typeof body.expires_at === "number" && Number.isFinite(body.expires_at)) {
    // cortex may send unix seconds or ms; treat large as ms
    return body.expires_at > 1e12 ? Math.floor(body.expires_at / 1000) : body.expires_at;
  }
  if (typeof body.expires_at === "string" && body.expires_at.length > 0) {
    const ms = Date.parse(body.expires_at);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return nowSeconds + (body.expires_in ?? 3600);
}

export function decodeTokenResponse(
  body: TokenResponse,
  nowSeconds = Math.floor(Date.now() / 1000),
): RemoteAuth {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: expiresAtSeconds(body, nowSeconds),
  };
}

let refreshRejected = false;

export function isRefreshRejected(): boolean {
  return refreshRejected;
}

async function requestRefresh(refreshToken: string, signal: AbortSignal): Promise<TokenResponse> {
  try {
    const data = await cortexFetch<TokenResponse>("/v1/auth/refresh", {
      method: "POST",
      body: { refresh_token: refreshToken },
      signal,
    });
    refreshRejected = false;
    return data;
  } catch (err) {
    if (err instanceof CortexApiError && err.httpStatus >= 400 && err.httpStatus < 500) {
      refreshRejected = true;
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function sameCredentials(left: RemoteAuth, right: RemoteAuth): boolean {
  return left.accessToken === right.accessToken && left.refreshToken === right.refreshToken;
}

function adoptAuth(auth: RemoteAuth): RemoteAuth {
  refreshRejected = false;
  if (socketAccessToken === auth.accessToken) return auth;
  socketAccessToken = auth.accessToken;
  void refreshSocketAuth(auth.accessToken).catch(() => {});
  return auth;
}

async function refreshSharedAuth(observed: RemoteAuth, force: boolean): Promise<RemoteAuth | null> {
  ensureRemoteHome();
  const lockCompromised = new AbortController();
  return withFileLock(
    authPath(),
    async () => {
      const latest = loadAuth();
      if (!latest) return null;
      if (!sameCredentials(latest, observed)) return adoptAuth(latest);
      if (!force && !isExpired(latest)) return latest;

      const body = await requestRefresh(
        latest.refreshToken,
        AbortSignal.any([lockCompromised.signal, AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS)]),
      );
      const decoded = decodeTokenResponse(body);
      const refreshed: RemoteAuth = {
        ...decoded,
        refreshToken: decoded.refreshToken || latest.refreshToken,
      };
      const current = loadAuth();
      if (!current) return null;
      if (!sameCredentials(current, latest)) return adoptAuth(current);

      saveAuth(refreshed);
      return adoptAuth(refreshed);
    },
    {
      maxWaitMs: REFRESH_LOCK_MAX_WAIT_MS,
      onCompromised: () => lockCompromised.abort(),
      staleAfterMs: REFRESH_LOCK_STALE_AFTER_MS,
      updateMs: REFRESH_LOCK_UPDATE_MS,
    },
  );
}

export async function refreshAuth(auth: RemoteAuth): Promise<RemoteAuth> {
  const refreshed = await refreshSharedAuth(auth, true);
  if (!refreshed) throw new Error("authentication was cleared during refresh");
  return refreshed;
}

let inFlightRefresh: Promise<RemoteAuth | null> | null = null;

function coordinateRefresh(auth: RemoteAuth, force: boolean): Promise<RemoteAuth | null> {
  if (Date.now() < nextRefreshAttempt) return Promise.resolve(null);
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = refreshSharedAuth(auth, force)
    .then((refreshed) => {
      nextRefreshAttempt = 0;
      return refreshed;
    })
    .catch(() => {
      nextRefreshAttempt = Date.now() + REFRESH_BACKOFF_MS;
      return null;
    })
    .finally(() => {
      inFlightRefresh = null;
    });
  return inFlightRefresh;
}

export async function loadFreshAuth(): Promise<RemoteAuth | null> {
  const auth = loadAuth();
  if (!auth) {
    socketAccessToken = null;
    return null;
  }
  if (!isExpired(auth)) return adoptAuth(auth);
  return coordinateRefresh(auth, false);
}

export async function forceRefreshAuth(rejectedAccessToken?: string): Promise<RemoteAuth | null> {
  const auth = loadAuth();
  if (!auth) return null;
  if (rejectedAccessToken && auth.accessToken !== rejectedAccessToken) return adoptAuth(auth);
  return coordinateRefresh(auth, true);
}
