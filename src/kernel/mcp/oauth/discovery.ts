const METADATA_TIMEOUT_MS = 15_000;

export interface AuthServerMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  codeChallengeMethods?: string[];
}

export interface WwwAuthenticateChallenge {
  scheme: string;
  scope: string | null;
  resourceMetadataUrl: string | null;
}

export function parseWwwAuthenticate(header: string | null): WwwAuthenticateChallenge | null {
  if (!header) return null;
  const trimmed = header.trim();
  const schemeMatch = /^([A-Za-z]+)\b/.exec(trimmed);
  const scheme = schemeMatch ? (schemeMatch[1] ?? "Bearer") : "Bearer";
  return {
    scheme,
    scope: extractParam(trimmed, "scope"),
    resourceMetadataUrl: extractParam(trimmed, "resource_metadata"),
  };
}

function extractParam(header: string, key: string): string | null {
  const quoted = new RegExp(`${key}\\s*=\\s*"([^"]*)"`, "i").exec(header);
  if (quoted) return quoted[1] ?? null;
  const bare = new RegExp(`${key}\\s*=\\s*([^,\\s]+)`, "i").exec(header);
  return bare ? (bare[1] ?? null) : null;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseAuthServerMetadata(body: Record<string, unknown>): AuthServerMetadata | null {
  const authorization =
    typeof body.authorization_endpoint === "string" ? body.authorization_endpoint : null;
  const token = typeof body.token_endpoint === "string" ? body.token_endpoint : null;
  if (!authorization || !token) return null;
  const registration =
    typeof body.registration_endpoint === "string" ? body.registration_endpoint : undefined;
  const methods =
    Array.isArray(body.code_challenge_methods_supported) &&
    body.code_challenge_methods_supported.every((m) => typeof m === "string")
      ? (body.code_challenge_methods_supported as string[])
      : undefined;
  return {
    authorizationEndpoint: authorization,
    tokenEndpoint: token,
    ...(registration !== undefined ? { registrationEndpoint: registration } : {}),
    ...(methods !== undefined ? { codeChallengeMethods: methods } : {}),
  };
}

function authServerMetadataCandidates(issuer: string): string[] {
  const trimmed = issuer.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return [`${trimmed}/.well-known/oauth-authorization-server`];
  }
  const origin = url.origin;
  const path = url.pathname.replace(/\/+$/, "");
  const candidates = new Set<string>();
  if (path && path !== "") {
    candidates.add(`${origin}/.well-known/oauth-authorization-server${path}`);
    candidates.add(`${origin}/.well-known/openid-configuration${path}`);
  }
  candidates.add(`${origin}/.well-known/oauth-authorization-server`);
  candidates.add(`${origin}/.well-known/openid-configuration`);
  return [...candidates];
}

async function discoverProtectedResourceAuthServer(
  serverUrl: string,
  resourceMetadataUrl: string | null,
): Promise<string | null> {
  const candidates = resourceMetadataUrl
    ? [resourceMetadataUrl]
    : protectedResourceCandidates(serverUrl);
  for (const url of candidates) {
    const body = await fetchJson(url);
    if (!body) continue;
    const servers = body.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === "string") {
      return servers[0];
    }
  }
  return null;
}

function protectedResourceCandidates(serverUrl: string): string[] {
  try {
    const url = new URL(serverUrl);
    const path = url.pathname.replace(/\/+$/, "");
    const candidates = new Set<string>();
    if (path && path !== "") {
      candidates.add(`${url.origin}/.well-known/oauth-protected-resource${path}`);
    }
    candidates.add(`${url.origin}/.well-known/oauth-protected-resource`);
    return [...candidates];
  } catch {
    return [];
  }
}

async function discoverFromIssuer(issuer: string): Promise<AuthServerMetadata | null> {
  for (const url of authServerMetadataCandidates(issuer)) {
    const body = await fetchJson(url);
    if (!body) continue;
    const parsed = parseAuthServerMetadata(body);
    if (parsed) return parsed;
  }
  return null;
}

export async function discoverAuthServer(options: {
  serverUrl: string;
  resourceMetadataUrl?: string | null;
}): Promise<AuthServerMetadata> {
  const authServer = await discoverProtectedResourceAuthServer(
    options.serverUrl,
    options.resourceMetadataUrl ?? null,
  );
  if (authServer) {
    const fromResource = await discoverFromIssuer(authServer);
    if (fromResource) return fromResource;
  }
  const fromServer = await discoverFromIssuer(options.serverUrl);
  if (fromServer) return fromServer;
  throw new Error(`OAuth discovery failed for ${options.serverUrl}`);
}
