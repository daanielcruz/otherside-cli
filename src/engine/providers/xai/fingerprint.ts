import { providerEndpoint } from "@/devtools/config.ts";
import type { WireFingerprint } from "@/engine/contract/types.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

// OAuth requests use the configured client ID, user-agent, headers, scope, and device-grant shape. Inference uses the CLI chat proxy rather than the public xAI API.
export const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_CLIENT_VERSION = "0.2.91";
// OAuth requests tag the surface; inference tags the client identifier.
export const GROK_CLIENT_SURFACE = "headless";
export const GROK_CLIENT_IDENTIFIER = "grok-shell";
// The CLI product tag ("grok-build") rides both the device referrer and the
// inference model-override header.
export const GROK_PRODUCT_TAG = "grok-build";

export const ISSUER = "https://auth.x.ai";
export const OAUTH_TOKEN_URL = providerEndpoint("xai", "token", `${ISSUER}/oauth2/token`);

// RFC 8628 device authorization grant — the headless / VPS / SSH path. The user
// opens a URL on any device and types a short code; the CLI long-polls the token
// endpoint. No loopback callback server, no inbound port, no firewall holes.
export const DEVICE_AUTH_URL = `${ISSUER}/oauth2/device/code`;
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export const SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

// Attribution string the grok-cli sends on the device authorization request.
export const OAUTH_REFERRER = GROK_PRODUCT_TAG;

// Inference goes through the CLI chat proxy — the OAuth SuperGrok token
// authenticates here, NOT against api.x.ai/v1 (which requires an API key).
export const BASE_URL = providerEndpoint("xai", "base", "https://cli-chat-proxy.grok.com/v1");
export const RESPONSES_URL = providerEndpoint("xai", "responses", `${BASE_URL}/responses`);

function osShort(): string {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return process.platform;
  }
}

function archShort(): string {
  switch (process.arch) {
    case "arm64":
      return "aarch64";
    case "x64":
      return "x86_64";
    default:
      return process.arch;
  }
}

export function userAgent(): string {
  return `grok-shell/${GROK_CLIENT_VERSION} (${osShort()}; ${archShort()})`;
}

// The x-grok-client-* pair rides every grok-cli OAuth request (surface variant).
export function clientHeaders(): Record<string, string> {
  return {
    "x-grok-client-version": GROK_CLIENT_VERSION,
    "x-grok-client-surface": GROK_CLIENT_SURFACE,
    "User-Agent": userAgent(),
  };
}

// The exact header set the grok-cli sends to the chat proxy /responses endpoint.
// The x-grok-{conv,req,session,agent}-id fields ride empty on a fresh turn.
export function inferenceHeaders(bearer: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: bearer,
    "x-xai-token-auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-version": GROK_CLIENT_VERSION,
    "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
    "x-grok-model-override": GROK_PRODUCT_TAG,
    "x-grok-conv-id": "",
    "x-grok-req-id": "",
    "x-grok-session-id": "",
    "x-grok-agent-id": "",
    "User-Agent": userAgent(),
  };
}

export function authHeaderValue(accessToken: string): string {
  return `Bearer ${accessToken}`;
}

export function fingerprint(_ctx: RequestContext): WireFingerprint {
  return {
    userAgent: userAgent(),
    extraHeaders: {
      "x-grok-client-version": GROK_CLIENT_VERSION,
      "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
    },
  };
}
