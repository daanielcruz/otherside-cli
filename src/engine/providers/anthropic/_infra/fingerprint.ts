import { createHash } from "node:crypto";
import { providerEndpoint } from "@/devtools/config.ts";
import type { WireFingerprint } from "@/engine/contract/types.ts";
import {
  CLAUDE_CODE_VERSION,
  STAINLESS_LANG,
  STAINLESS_PACKAGE_VERSION,
  STAINLESS_RUNTIME,
  STAINLESS_RUNTIME_VERSION,
} from "@/engine/contract/wire-version.ts";
import { parseModelId } from "@/engine/model/catalog.ts";
import {
  isHaikuModel,
  modelSupportsMidConversationSystemBeta,
} from "@/engine/model/facts/model-family.ts";
import { latchFastModeIf } from "@/engine/providers/anthropic/_infra/wire-latches.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export { CLAUDE_CODE_VERSION };
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export const OAUTH_AUTHORIZE_URL = providerEndpoint(
  "anthropic",
  "authorize",
  "https://claude.com/cai/oauth/authorize",
);
export const OAUTH_TOKEN_URL = providerEndpoint(
  "anthropic",
  "token",
  "https://platform.claude.com/v1/oauth/token",
);
export const OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";

export const API_MESSAGES_URL = providerEndpoint(
  "anthropic",
  "messages",
  "https://api.anthropic.com/v1/messages?beta=true",
);
export const API_USAGE_URL = providerEndpoint(
  "anthropic",
  "usage",
  "https://api.anthropic.com/api/oauth/usage",
);

export const LOGIN_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

export const REFRESH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

export const UA_AXIOS = "axios/1.13.6";

const ANTHROPIC_VERSION = "2023-06-01";

const CLAUDE_CODE_BETA = "claude-code-20250219";
export const OAUTH_BETA = "oauth-2025-04-20";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
export const REDACT_THINKING_BETA = "redact-thinking-2026-02-12";
const THINKING_TOKEN_COUNT_BETA = "thinking-token-count-2026-05-13";
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const PROMPT_CACHING_SCOPE_BETA = "prompt-caching-scope-2026-01-05";
const MID_CONVERSATION_SYSTEM_BETA = "mid-conversation-system-2026-04-07";
export const ADVANCED_TOOL_USE_BETA = "advanced-tool-use-2025-11-20";
const EFFORT_BETA = "effort-2025-11-24";
export const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";
export const STRUCTURED_OUTPUTS_BETA = "structured-outputs-2025-12-15";
export const FAST_MODE_BETA = "fast-mode-2026-02-01";

// First-party Haiku wire id is always the dated config string.
// Catalog may still list the undated alias.
const WIRE_MODEL_OVERRIDES: Record<string, string> = {
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};

export function anthropicWireModelId(base: string, _userTopLevelTurn?: boolean): string {
  return WIRE_MODEL_OVERRIDES[base] ?? base;
}

function buildModelBetas(
  base: string,
  is1m: boolean,
  agentic: boolean,
  fastModeLatched: boolean,
  structuredOutput: boolean,
  deferredToolLoading: boolean,
  extendedCacheTtl: boolean,
  redactThinking: boolean,
): string[] {
  const haiku = isHaikuModel(base);
  const supportsMidConvSystem = modelSupportsMidConversationSystemBeta(base);
  // Non-agentic side queries omit request-feature betas. Structured output tracks
  // the request body, while the quota probe omits it.
  const sideQueryPath = !agentic;
  const out: string[] = [];
  if (!haiku) out.push(CLAUDE_CODE_BETA);
  out.push(OAUTH_BETA);
  if (is1m) out.push(BETA_CONTEXT_1M);
  out.push(INTERLEAVED_THINKING_BETA);
  if (!haiku && redactThinking) out.push(REDACT_THINKING_BETA);
  out.push(THINKING_TOKEN_COUNT_BETA);
  out.push(CONTEXT_MANAGEMENT_BETA);
  out.push(PROMPT_CACHING_SCOPE_BETA);
  if (supportsMidConvSystem) out.push(MID_CONVERSATION_SYSTEM_BETA);
  // Agentic haiku carries the CLI beta header after the cache headers rather than before them, unlike opus and sonnet.
  if (haiku && agentic) out.push(CLAUDE_CODE_BETA);
  if (sideQueryPath) {
    if (structuredOutput) out.push(STRUCTURED_OUTPUTS_BETA);
    if (extendedCacheTtl) out.push(EXTENDED_CACHE_TTL_BETA);
    return out;
  }
  if (deferredToolLoading) out.push(ADVANCED_TOOL_USE_BETA);
  if (!haiku) out.push(EFFORT_BETA);
  if (structuredOutput) out.push(STRUCTURED_OUTPUTS_BETA);
  if (fastModeLatched) out.push(FAST_MODE_BETA);
  if (extendedCacheTtl) out.push(EXTENDED_CACHE_TTL_BETA);
  return out;
}

const BETA_CONTEXT_1M = "context-1m-2025-08-07";
export const ANTHROPIC_BETA_WEB_SEARCH = [
  CLAUDE_CODE_BETA,
  OAUTH_BETA,
  BETA_CONTEXT_1M,
  INTERLEAVED_THINKING_BETA,
  CONTEXT_MANAGEMENT_BETA,
  PROMPT_CACHING_SCOPE_BETA,
  EFFORT_BETA,
].join(",");

const STAINLESS_TIMEOUT = "600";

function stainlessArch(): string {
  switch (process.arch) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x64";
    case "ia32":
      return "ia32";
    default:
      return process.arch;
  }
}

function stainlessOs(): string {
  switch (process.platform) {
    case "darwin":
      return "MacOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    case "freebsd":
      return "FreeBSD";
    case "openbsd":
      return "OpenBSD";
    default:
      return process.platform;
  }
}

export function uaCli(): string {
  return `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
}

export function uaClaudeCode(): string {
  return `claude-code/${CLAUDE_CODE_VERSION}`;
}

function subagentWireId(agentOwnerId: string): string {
  return `a${createHash("sha256").update(agentOwnerId).digest("hex").slice(0, 16)}`;
}

function requestTools(body: unknown): Array<Record<string, unknown>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  const tools = (body as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (tool): tool is Record<string, unknown> =>
      typeof tool === "object" && tool !== null && !Array.isArray(tool),
  );
}

function requestUsesDeferredToolLoading(body: unknown): boolean {
  const tools = requestTools(body);
  return (
    tools.some((tool) => tool.name === "ToolSearch") &&
    tools.some((tool) => tool.defer_loading === true)
  );
}

function requestUsesStructuredOutput(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const outputConfig = (body as Record<string, unknown>).output_config;
  return (
    typeof outputConfig === "object" &&
    outputConfig !== null &&
    !Array.isArray(outputConfig) &&
    "format" in outputConfig
  );
}

function requestUsesAdaptiveThinking(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const thinking = (body as Record<string, unknown>).thinking;
  return (
    typeof thinking === "object" &&
    thinking !== null &&
    !Array.isArray(thinking) &&
    (thinking as Record<string, unknown>).type === "adaptive"
  );
}

// Extended (1h) cache TTL is negotiated per request: the beta header and the
// body's cache_control ttl fields must agree, so this single predicate decides
// both. Subagents, fork children, and non-agentic side queries stay on the
// default ephemeral cache.
export function requestQualifiesForExtendedCacheTtl(ctx: RequestContext): boolean {
  // A side question shares the parent cache prefix without writing its own
  // entries, so it never carries the extended-ttl beta.
  if (ctx.cacheRole === "side-question") return false;
  return (
    ctx.requestRole === "memory_recall" ||
    (ctx.agentic !== false && ctx.agentOwnerId === undefined && ctx.isForkChild !== true)
  );
}

export function fingerprint(ctx: RequestContext, body?: unknown): WireFingerprint {
  const parsed = parseModelId(ctx.model);
  const agentic = ctx.agentic !== false;
  const fastModeLatched = latchFastModeIf(ctx.fastMode === true);
  const extendedCacheTtl = requestQualifiesForExtendedCacheTtl(ctx);
  const redactThinking =
    requestUsesAdaptiveThinking(body) &&
    ctx.disableThinking !== true &&
    (ctx.showThinkingSummaries === false || ctx.suppressThinkingSummary === true);
  const betas = buildModelBetas(
    parsed.base,
    parsed.is1m,
    agentic,
    fastModeLatched,
    ctx.cacheRole === "title" || requestUsesStructuredOutput(body),
    requestUsesDeferredToolLoading(body),
    extendedCacheTtl,
    redactThinking,
  );
  const userAgent = uaCli();

  const extraHeaders: Record<string, string> = {
    "X-Stainless-Lang": STAINLESS_LANG,
    "X-Stainless-Package-Version": STAINLESS_PACKAGE_VERSION,
    "X-Stainless-Runtime": STAINLESS_RUNTIME,
    "X-Stainless-Runtime-Version": STAINLESS_RUNTIME_VERSION,
    "X-Stainless-Timeout": STAINLESS_TIMEOUT,
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Arch": stainlessArch(),
    "X-Stainless-OS": stainlessOs(),
    "X-Claude-Code-Session-Id": ctx.sessionId,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": betas.join(","),
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "x-client-request-id": uuidv4(),
  };

  if (ctx.agentOwnerId !== undefined) {
    extraHeaders["x-claude-code-agent-id"] = subagentWireId(ctx.agentOwnerId);
  }

  if (ctx.parentAgentOwnerId !== undefined) {
    extraHeaders["x-claude-code-parent-agent-id"] = subagentWireId(ctx.parentAgentOwnerId);
  }

  return {
    userAgent,
    betaHeaders: betas,
    extraHeaders,
  };
}
