import { providerEndpoint } from "@/devtools/config.ts";
import type { WireFingerprint } from "@/engine/contract/types.ts";
import { CLAUDE_CODE_VERSION } from "@/engine/contract/wire-version.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const API_MESSAGES_URL = providerEndpoint(
  "minimax",
  "messages",
  "https://api.minimax.io/anthropic/v1/messages",
);
export const CONSOLE_URL =
  "https://platform.minimax.io/user-center/basic-information/interface-key";

export const ENV_VAR_CANONICAL = "OTHERSIDE_MINIMAX_API_KEY";
export const ENV_VAR_VENDOR = "MINIMAX_API_KEY";

export const ANTHROPIC_VERSION = "2023-06-01";

function uaCli(): string {
  return `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
}

export function fingerprint(_ctx: RequestContext): WireFingerprint {
  const extraHeaders: Record<string, string> = {
    "anthropic-version": ANTHROPIC_VERSION,
    "x-client-request-id": uuidv4(),
  };
  return {
    userAgent: uaCli(),
    extraHeaders,
  };
}

export function authHeader(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}
