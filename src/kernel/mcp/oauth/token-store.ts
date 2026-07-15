import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { credentialsPath } from "@/kernel/std/fs/paths.ts";
import { chmodIfPosix, renameReplaceSync } from "@/kernel/std/fs/secure-fs.ts";

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: number;
  scope?: string;
  obtainedAt: number;
}

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret?: string;
}

export interface OAuthDiscoveryState {
  tokenEndpoint: string;
  authorizationEndpoint: string;
  registrationEndpoint?: string;
  resource?: string;
}

export interface OAuthRecord {
  token?: OAuthToken;
  client?: OAuthClientCredentials;
  discovery?: OAuthDiscoveryState;
}

const FILE_MODE = 0o600;
const TOKEN_REFRESH_SKEW_MS = 60_000;

function recordKey(serverName: string): string {
  return `mcp:${serverName}`;
}

function readAll(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(credentialsPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeAll(all: Record<string, unknown>): Promise<void> {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Date.now()}`;
  await Bun.write(tmp, JSON.stringify(all, null, 2));
  chmodIfPosix(tmp, FILE_MODE);
  renameReplaceSync(tmp, path);
}

function parseToken(value: unknown): OAuthToken | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const accessToken = typeof obj.accessToken === "string" ? obj.accessToken : null;
  if (!accessToken) return null;
  return {
    accessToken,
    tokenType: typeof obj.tokenType === "string" ? obj.tokenType : "Bearer",
    obtainedAt: typeof obj.obtainedAt === "number" ? obj.obtainedAt : 0,
    ...(typeof obj.refreshToken === "string" ? { refreshToken: obj.refreshToken } : {}),
    ...(typeof obj.expiresAt === "number" ? { expiresAt: obj.expiresAt } : {}),
    ...(typeof obj.scope === "string" ? { scope: obj.scope } : {}),
  };
}

function parseClient(value: unknown): OAuthClientCredentials | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const clientId = typeof obj.clientId === "string" ? obj.clientId : null;
  if (!clientId) return null;
  return {
    clientId,
    ...(typeof obj.clientSecret === "string" ? { clientSecret: obj.clientSecret } : {}),
  };
}

function parseDiscovery(value: unknown): OAuthDiscoveryState | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const tokenEndpoint = typeof obj.tokenEndpoint === "string" ? obj.tokenEndpoint : null;
  const authorizationEndpoint =
    typeof obj.authorizationEndpoint === "string" ? obj.authorizationEndpoint : null;
  if (!tokenEndpoint || !authorizationEndpoint) return null;
  return {
    tokenEndpoint,
    authorizationEndpoint,
    ...(typeof obj.registrationEndpoint === "string"
      ? { registrationEndpoint: obj.registrationEndpoint }
      : {}),
    ...(typeof obj.resource === "string" ? { resource: obj.resource } : {}),
  };
}

export function loadOAuthRecord(serverName: string): OAuthRecord {
  const value = readAll()[recordKey(serverName)];
  if (!value || typeof value !== "object") return {};
  const obj = value as Record<string, unknown>;
  if ("accessToken" in obj) {
    const token = parseToken(obj);
    return token ? { token } : {};
  }
  const token = parseToken(obj.token);
  const client = parseClient(obj.client);
  const discovery = parseDiscovery(obj.discovery);
  return {
    ...(token ? { token } : {}),
    ...(client ? { client } : {}),
    ...(discovery ? { discovery } : {}),
  };
}

export async function patchOAuthRecord(
  serverName: string,
  patch: Partial<OAuthRecord>,
): Promise<void> {
  const all = readAll();
  const current = loadOAuthRecord(serverName);
  all[recordKey(serverName)] = {
    ...current,
    ...patch,
  };
  await writeAll(all);
}

export async function saveOAuthToken(serverName: string, token: OAuthToken): Promise<void> {
  await patchOAuthRecord(serverName, { token });
}

export function loadOAuthToken(serverName: string): OAuthToken | null {
  return loadOAuthRecord(serverName).token ?? null;
}

export function isExpired(token: OAuthToken, nowMs: number = Date.now()): boolean {
  if (!token.expiresAt) return false;
  return nowMs >= token.expiresAt - TOKEN_REFRESH_SKEW_MS;
}

export function authorizationHeader(token: OAuthToken): string {
  return `${token.tokenType || "Bearer"} ${token.accessToken}`;
}
