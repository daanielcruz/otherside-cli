import { release as osRelease } from "node:os";
import { providerEndpoint } from "@/devtools/config.ts";
import type { WireFingerprint } from "@/engine/contract/types.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const API_MESSAGES_URL = providerEndpoint(
  "glm",
  "messages",
  "https://api.z.ai/api/anthropic/v1/messages",
);
export const CONSOLE_URL = "https://chat.z.ai";

export const OAUTH_AUTHORIZE_URL = providerEndpoint(
  "glm",
  "authorize",
  "https://chat.z.ai/auth/oauth/authorize",
);
export const OAUTH_TOKEN_URL = providerEndpoint(
  "glm",
  "token",
  "https://zcode.z.ai/api/v1/oauth/token",
);
export const OAUTH_CALLBACK_PATH = "/glm/oauth/callback";
export const OAUTH_PORT_START = 55240;
export const OAUTH_PROVIDER = "zai";
export const CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";

export const ZAI_BIZ_LOGIN_URL = "https://api.z.ai/api/auth/z/login";
export const ZAI_BIZ_CUSTOMER_URL = "https://api.z.ai/api/biz/customer/getCustomerInfo";
export const ZAI_BIZ_API_KEYS_BASE = "https://api.z.ai/api/biz/v1/organization";
export const ZAI_API_KEY_NAME = "zcode-api-key";

export const ANTHROPIC_VERSION = "2023-06-01";
export const ZCODE_APP_VERSION = "3.2.5";
export const ZCODE_AUTH_REFRESH_MARGIN_MS = 60_000;
export const ZCODE_BETA_CHAT = "mid-conversation-system-2026-04-07";
export const ZCODE_BETA_WEB_SEARCH = "code-execution-web-tools-2026-02-09";
export const ZCODE_USER_AGENT = "ZCode/3.2.5 ai-sdk/provider-utils/4.0.27 runtime/node.js/24";

const queryIds = new WeakMap<RequestContext, string>();
const turnQueryIds = new Map<string, string>();
const traceIds = new Map<string, string>();

function platformName(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return process.platform;
}

function platformArch(): string {
  return `${process.platform}-${process.arch}`;
}

function traceId(ctx: RequestContext): string {
  const existing = traceIds.get(ctx.sessionId);
  if (existing) return existing;
  const next = uuidv4();
  traceIds.set(ctx.sessionId, next);
  return next;
}

// Stable for a user query, reused across follow-up subrequests within the
// same tool-loop turn (captured ZCode behavior). Keyed on ctx.turnId when the
// caller threads one through; ctx object identity is a fallback for the rare
// paths that don't (each makeRequestContext() call there gets a fresh ctx, so
// the fallback degrades to a fresh id per call — not turn-stable, but no
// caller on that path currently multi-calls within a turn).
function queryId(ctx: RequestContext): string {
  if (ctx.turnId) {
    const existing = turnQueryIds.get(ctx.turnId);
    if (existing) return existing;
    const next = uuidv4();
    turnQueryIds.set(ctx.turnId, next);
    return next;
  }
  const existing = queryIds.get(ctx);
  if (existing) return existing;
  const next = uuidv4();
  queryIds.set(ctx, next);
  return next;
}

export function fingerprint(ctx: RequestContext, beta = ZCODE_BETA_CHAT): WireFingerprint {
  const extraHeaders: Record<string, string> = {
    "anthropic-beta": beta,
    "anthropic-version": ANTHROPIC_VERSION,
    "http-referer": "https://zcode.z.ai",
    "x-os-category": platformName(),
    "x-os-version": osRelease(),
    "x-platform": platformArch(),
    "x-request-id": uuidv4(),
    "x-session-id": ctx.sessionId,
    "x-title": "Z Code@electron",
    "x-zcode-agent": "glm",
    "x-zcode-app-version": ZCODE_APP_VERSION,
    "x-zcode-trace-id": traceId(ctx),
    Connection: "close",
  };
  if (beta !== ZCODE_BETA_WEB_SEARCH) extraHeaders["x-query-id"] = queryId(ctx);
  return {
    userAgent: ZCODE_USER_AGENT,
    extraHeaders,
  };
}

export function authHeader(chatCredential: string): Record<string, string> {
  return {
    authorization: `Bearer ${chatCredential}`,
    "x-api-key": chatCredential,
  };
}
