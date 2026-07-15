import type { AuthServerMetadata } from "./discovery.ts";
import type { OAuthClientCredentials } from "./token-store.ts";

const REGISTRATION_TIMEOUT_MS = 15_000;
const FALLBACK_CLIENT_ID = "otherside-mcp-cli";

export async function registerClient(options: {
  metadata: AuthServerMetadata;
  redirectUri: string;
  serverName: string;
}): Promise<OAuthClientCredentials> {
  const { metadata, redirectUri, serverName } = options;
  if (!metadata.registrationEndpoint) {
    return { clientId: FALLBACK_CLIENT_ID };
  }
  const res = await fetch(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `otherside (${serverName})`,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(REGISTRATION_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`dynamic client registration failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const clientId = typeof body.client_id === "string" ? body.client_id : null;
  if (!clientId) throw new Error("registration response missing client_id");
  const clientSecret = typeof body.client_secret === "string" ? body.client_secret : undefined;
  return clientSecret ? { clientId, clientSecret } : { clientId };
}
