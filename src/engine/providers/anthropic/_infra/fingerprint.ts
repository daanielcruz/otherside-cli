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
export const API_PROFILE_URL = providerEndpoint(
  "anthropic",
  "profile",
  "https://api.anthropic.com/api/oauth/profile",
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

export const ANTHROPIC_VERSION = "2023-06-01";

export const CLAUDE_CODE_BETA = "claude-code-20250219";
export const OAUTH_BETA = "oauth-2025-04-20";
export const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
export const THINKING_TOKEN_COUNT_BETA = "thinking-token-count-2026-05-13";
export const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
export const PROMPT_CACHING_SCOPE_BETA = "prompt-caching-scope-2026-01-05";
export const MID_CONVERSATION_SYSTEM_BETA = "mid-conversation-system-2026-04-07";
export const ADVANCED_TOOL_USE_BETA = "advanced-tool-use-2025-11-20";
export const EFFORT_BETA = "effort-2025-11-24";
export const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";
export const STRUCTURED_OUTPUTS_BETA = "structured-outputs-2025-12-15";
export const FAST_MODE_BETA = "fast-mode-2026-02-01";

// First-party Haiku wire id is always the dated config string (reference
// CLAUDE_HAIKU_4_5_CONFIG.firstParty). Catalog may still list the undated alias.
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
): string[] {
  const haiku = isHaikuModel(base);
  const supportsMidConvSystem = modelSupportsMidConversationSystemBeta(base);
  // Haiku's non-agentic calls (probe/title/summary) use a minimal beta set: omit the CLI, advanced-tool-use, and extended-cache-ttl beta headers. Include structured-outputs only when the request body uses a structured output format; the quota probe omits it and the title request includes it.
  const minimalSideQueryPath = haiku && !agentic;
  const out: string[] = [];
  if (!haiku) out.push(CLAUDE_CODE_BETA);
  out.push(OAUTH_BETA);
  if (is1m) out.push(BETA_CONTEXT_1M);
  out.push(INTERLEAVED_THINKING_BETA);
  out.push(THINKING_TOKEN_COUNT_BETA);
  out.push(CONTEXT_MANAGEMENT_BETA);
  out.push(PROMPT_CACHING_SCOPE_BETA);
  if (supportsMidConvSystem) out.push(MID_CONVERSATION_SYSTEM_BETA);
  // Agentic haiku carries the CLI beta header after the cache headers rather than before them, unlike opus and sonnet.
  if (haiku && agentic) out.push(CLAUDE_CODE_BETA);
  if (minimalSideQueryPath) {
    if (structuredOutput) out.push(STRUCTURED_OUTPUTS_BETA);
    if (fastModeLatched) out.push(FAST_MODE_BETA);
    return out;
  }
  out.push(ADVANCED_TOOL_USE_BETA);
  if (!haiku) out.push(EFFORT_BETA);
  out.push(EXTENDED_CACHE_TTL_BETA);
  if (fastModeLatched) out.push(FAST_MODE_BETA);
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

export function fingerprint(ctx: RequestContext): WireFingerprint {
  const parsed = parseModelId(ctx.model);
  const fastModeLatched = latchFastModeIf(ctx.fastMode === true);
  // Among the non-agentic side flows only the title request carries a
  // structured output_config.format in its body — the beta tracks the body.
  const structuredOutput = ctx.cacheRole === "title";
  const betas = buildModelBetas(
    parsed.base,
    parsed.is1m,
    ctx.agentic !== false,
    fastModeLatched,
    structuredOutput,
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

  return {
    userAgent,
    betaHeaders: betas,
    extraHeaders,
  };
}
