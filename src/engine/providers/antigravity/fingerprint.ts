import { providerEndpoint } from "@/devtools/config.ts";
import type { WireFingerprint } from "@/engine/contract/types.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

// The model catalog is version-gated server-side: a 1.1.4 client never sees
// the gemini-3.7 tier entries and is told 3.6 is the default. Keep this pinned
// to the installed Antigravity CLI release.
export const CLI_VERSION = "1.1.13";

export const PROD_HOST = "https://cloudcode-pa.googleapis.com";
export const DAILY_HOST = "https://daily-cloudcode-pa.googleapis.com";

export const STREAM_GENERATE_CONTENT_PATH = "/v1internal:streamGenerateContent";
export const GENERATE_CONTENT_PATH = "/v1internal:generateContent";

export const ANTIGRAVITY_HOST_VAR = "OTHERSIDE_ANTIGRAVITY_HOST";

function goos(): string {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return process.platform;
  }
}

function goarch(): string {
  switch (process.arch) {
    case "arm64":
      return "arm64";
    case "x64":
      return "amd64";
    default:
      return process.arch;
  }
}

export function userAgent(): string {
  // `auth_method=consumer` entered the UA at 1.0.16; our OAuth path is always the
  // consumer installed-app client (personal Google account → GOOGLE_ONE_AI credits),
  // never workspace/enterprise, so the segment is fixed.
  return `antigravity/cli/${CLI_VERSION} (aidev_client; os_type=${goos()}; arch=${goarch()}; auth_method=consumer)`;
}

export function backendHost(): string {
  const host = process.env[ANTIGRAVITY_HOST_VAR]?.trim().toLowerCase();
  const selected = host === "prod" ? PROD_HOST : DAILY_HOST;
  return providerEndpoint("antigravity", "base", selected);
}

export function streamGenerateContentUrl(): string {
  const u = new URL(`${backendHost()}${STREAM_GENERATE_CONTENT_PATH}`);
  u.searchParams.set("alt", "sse");
  return u.toString();
}

export function generateContentUrl(): string {
  return providerEndpoint("antigravity", "images", `${backendHost()}${GENERATE_CONTENT_PATH}`);
}

export interface AntigravityHeaderOptions {
  bearer: string;
}

export function buildInferenceHeaders(opts: AntigravityHeaderOptions): Record<string, string> {
  return {
    "User-Agent": userAgent(),
    "Transfer-Encoding": "chunked",
    Authorization: opts.bearer,
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  };
}

export const TOP_USER_AGENT = "antigravity";
export const REQUEST_TYPE = "agent";

export interface CloudCodeEnvelopeInput {
  model: string;
  project: string;
  requestId: string;
  request: Record<string, unknown>;
  requestType?: string;
  userAgent?: string;
  googleOneAi?: boolean;
}

export interface RequestIdInput {
  conversationId: string;
  trajectoryId: string;
  turn: number;
}

export function buildRequestId(input: RequestIdInput): string {
  return `agent/${input.conversationId}/${Date.now()}/${input.trajectoryId}/${input.turn}`;
}

export function buildCloudCodeEnvelope(input: CloudCodeEnvelopeInput): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    project: input.project,
    requestId: input.requestId,
    request: input.request,
    model: input.model,
    userAgent: input.userAgent ?? TOP_USER_AGENT,
    requestType: input.requestType ?? REQUEST_TYPE,
  };
  if (input.googleOneAi !== false) {
    envelope.enabledCreditTypes = ["GOOGLE_ONE_AI"];
  }
  return envelope;
}

export function fingerprint(_ctx: RequestContext): WireFingerprint {
  return {
    userAgent: userAgent(),
    extraHeaders: {
      "Accept-Encoding": "gzip",
    },
  };
}
