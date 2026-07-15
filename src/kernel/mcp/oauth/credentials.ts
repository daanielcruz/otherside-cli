import { discoverAuthServer } from "./discovery.ts";
import { InvalidGrantError, refreshAccessToken } from "./token-endpoint.ts";
import {
  authorizationHeader,
  isExpired,
  loadOAuthRecord,
  type OAuthDiscoveryState,
  patchOAuthRecord,
  saveOAuthToken,
} from "./token-store.ts";

export type CredentialResult =
  | { kind: "header"; value: string }
  | { kind: "none" }
  | { kind: "needs-auth"; reason: string };

const refreshLocks = new Map<string, Promise<CredentialResult>>();

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function tokenBoundToServer(serverName: string, serverUrl: string): boolean {
  const boundResource = loadOAuthRecord(serverName).discovery?.resource;
  if (boundResource === undefined) return false;
  return sameOrigin(boundResource, serverUrl);
}

export async function resolveAuthHeader(options: {
  serverName: string;
  serverUrl: string;
}): Promise<CredentialResult> {
  const { serverName, serverUrl } = options;
  const record = loadOAuthRecord(serverName);
  const token = record.token;
  if (!token) return { kind: "none" };
  if (!tokenBoundToServer(serverName, serverUrl)) return { kind: "none" };
  if (!isExpired(token)) return { kind: "header", value: authorizationHeader(token) };
  if (!token.refreshToken) {
    return { kind: "needs-auth", reason: "access token expired and no refresh token available" };
  }
  return refreshWithLock(serverName);
}

export async function refreshWithLock(serverName: string): Promise<CredentialResult> {
  const existing = refreshLocks.get(serverName);
  if (existing) return existing;
  const pending = performRefresh(serverName).finally(() => refreshLocks.delete(serverName));
  refreshLocks.set(serverName, pending);
  return pending;
}

async function performRefresh(serverName: string): Promise<CredentialResult> {
  const record = loadOAuthRecord(serverName);
  const token = record.token;
  if (!token) return { kind: "none" };
  if (!isExpired(token)) return { kind: "header", value: authorizationHeader(token) };
  if (!token.refreshToken || !record.client) {
    return { kind: "needs-auth", reason: "missing refresh token or client registration" };
  }
  const discovery = await ensureDiscovery(serverName, record.discovery);
  if (!discovery) {
    return { kind: "needs-auth", reason: "could not resolve token endpoint for refresh" };
  }
  try {
    const refreshed = await refreshAccessToken({
      tokenEndpoint: discovery.tokenEndpoint,
      client: record.client,
      refreshToken: token.refreshToken,
      ...(discovery.resource ? { resource: discovery.resource } : {}),
      ...(token.scope ? { scope: token.scope } : {}),
    });
    await saveOAuthToken(serverName, refreshed);
    return { kind: "header", value: authorizationHeader(refreshed) };
  } catch (e) {
    if (e instanceof InvalidGrantError) {
      return { kind: "needs-auth", reason: "refresh token rejected — re-authentication required" };
    }
    return { kind: "needs-auth", reason: e instanceof Error ? e.message : String(e) };
  }
}

async function ensureDiscovery(
  serverName: string,
  cached: OAuthDiscoveryState | undefined,
): Promise<OAuthDiscoveryState | null> {
  if (cached) return cached;
  const resource = loadOAuthRecord(serverName).discovery?.resource;
  if (!resource) return null;
  try {
    const metadata = await discoverAuthServer({ serverUrl: resource });
    const discovery: OAuthDiscoveryState = {
      tokenEndpoint: metadata.tokenEndpoint,
      authorizationEndpoint: metadata.authorizationEndpoint,
      ...(metadata.registrationEndpoint
        ? { registrationEndpoint: metadata.registrationEndpoint }
        : {}),
      resource,
    };
    await patchOAuthRecord(serverName, { discovery });
    return discovery;
  } catch {
    return null;
  }
}
