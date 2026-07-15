import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { writeFileSecure } from "@/kernel/std/fs/secure-fs.ts";
import { CortexApiError, cortexFetch } from "@/remote/_infra/cortex.ts";
import { authPath, ensureRemoteHome, peerPath, peersDir } from "@/remote/_infra/paths.ts";
import { refreshSocketAuth } from "@/remote/_infra/realtime.ts";

const FILE_MODE = 0o600;
const EXPIRY_LEAD_SECONDS = 600;
const REFRESH_BACKOFF_MS = 30_000;

let nextRefreshAttempt = 0;

export interface RemoteAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
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

export function decodeUserId(accessToken: string): string {
  const parts = accessToken.split(".");
  if (parts.length < 2) return "";
  try {
    const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      sub?: string;
    };
    return claims.sub ?? "";
  } catch {
    return "";
  }
}

export function currentUserId(): string | null {
  const auth = loadAuth();
  if (!auth) return null;
  const id = decodeUserId(auth.accessToken);
  return id.length > 0 ? id : null;
}

export function decodeUserEmail(accessToken: string): string {
  const parts = accessToken.split(".");
  if (parts.length < 2) return "";
  try {
    const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      email?: string;
    };
    return claims.email ?? "";
  } catch {
    return "";
  }
}

export function currentUserEmail(): string | null {
  const auth = loadAuth();
  if (!auth) return null;
  const email = decodeUserEmail(auth.accessToken);
  return email.length > 0 ? email : null;
}

export function saveAuth(auth: RemoteAuth): void {
  ensureRemoteHome();
  writeFileSecure(authPath(), JSON.stringify(toStored(auth), null, 2), FILE_MODE);
}

export function clearAuth(): void {
  // Best-effort server revoke so refresh CAS family cannot be reused offline.
  try {
    const raw = existsSync(authPath()) ? readFileSync(authPath(), "utf8") : "";
    if (raw.trim()) {
      const stored = JSON.parse(raw) as StoredAuth;
      if (stored.access_token) {
        void cortexFetch("/v1/auth/logout", {
          method: "POST",
          token: stored.access_token,
          body: { scope: "local" },
        }).catch(() => {});
      }
    }
  } catch {
    /* ignore */
  }
  if (existsSync(authPath())) writeFileSecure(authPath(), "", FILE_MODE);
  try {
    const dir = peersDir();
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir)) {
        if (entry.endsWith(".json")) {
          rmSync(peerPath(entry.slice(0, -".json".length)));
        }
      }
    }
  } catch {
    /* ignore */
  }
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

async function requestRefresh(refreshToken: string): Promise<TokenResponse> {
  try {
    const data = await cortexFetch<TokenResponse>("/v1/auth/refresh", {
      method: "POST",
      body: { refresh_token: refreshToken },
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

export async function refreshAuth(auth: RemoteAuth): Promise<RemoteAuth> {
  const body = await requestRefresh(auth.refreshToken);
  const decoded = decodeTokenResponse(body);
  const refreshed: RemoteAuth = {
    ...decoded,
    refreshToken: decoded.refreshToken || auth.refreshToken,
  };
  saveAuth(refreshed);
  void refreshSocketAuth(refreshed.accessToken).catch(() => {});
  return refreshed;
}

let inFlightRefresh: Promise<RemoteAuth | null> | null = null;

export async function loadFreshAuth(): Promise<RemoteAuth | null> {
  const auth = loadAuth();
  if (!auth) return null;
  if (!isExpired(auth)) return auth;
  if (Date.now() < nextRefreshAttempt) return null;
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = refreshAuth(auth)
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

export async function forceRefreshAuth(): Promise<RemoteAuth | null> {
  const auth = loadAuth();
  if (!auth) return null;
  if (Date.now() < nextRefreshAttempt) return null;
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = refreshAuth(auth)
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
