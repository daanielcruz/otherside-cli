import { providerEndpoint } from "@/devtools/config.ts";
import type { WireFingerprint } from "@/engine/contract/types.ts";
import {
  CLAUDE_CODE_VERSION,
  STAINLESS_LANG,
  STAINLESS_PACKAGE_VERSION,
  STAINLESS_RUNTIME,
  STAINLESS_RUNTIME_VERSION,
} from "@/engine/contract/wire-version.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const API_MESSAGES_URL = providerEndpoint(
  "kimi",
  "messages",
  "https://api.kimi.com/coding/v1/messages",
);
export const CONSOLE_URL = "https://www.kimi.com/code/console";

export const ENV_VAR_CANONICAL = "OTHERSIDE_KIMI_API_KEY";
export const ENV_VAR_VENDOR = "KIMI_API_KEY";

export const ANTHROPIC_VERSION = "2023-06-01";

const ANTHROPIC_BETA_INFERENCE = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
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

function uaSdkCli(): string {
  return `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`;
}

export function fingerprint(ctx: RequestContext): WireFingerprint {
  const extraHeaders: Record<string, string> = {
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": ANTHROPIC_BETA_INFERENCE,
    "anthropic-dangerous-direct-browser-access": "true",
    "x-stainless-lang": STAINLESS_LANG,
    "x-stainless-package-version": STAINLESS_PACKAGE_VERSION,
    "x-stainless-runtime": STAINLESS_RUNTIME,
    "x-stainless-runtime-version": STAINLESS_RUNTIME_VERSION,
    "x-stainless-timeout": STAINLESS_TIMEOUT,
    "x-stainless-retry-count": "0",
    "x-stainless-arch": stainlessArch(),
    "x-stainless-os": stainlessOs(),
    "x-app": "cli",
    "x-claude-code-session-id": ctx.sessionId,
    "x-client-request-id": uuidv4(),
  };

  return {
    userAgent: uaSdkCli(),
    extraHeaders,
  };
}

export function authHeader(apiKey: string): Record<string, string> {
  return { "x-api-key": apiKey };
}
