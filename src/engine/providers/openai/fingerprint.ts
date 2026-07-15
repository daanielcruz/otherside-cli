import type { WireFingerprint } from "@/engine/contract/types.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const DEFAULT_BASE_URL = "http://localhost:1234";

const UA = "otherside-cli/0.1 (openai-compatible)";

export function fingerprint(_ctx: RequestContext): WireFingerprint {
  const extraHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  return {
    userAgent: UA,
    extraHeaders,
  };
}

export function authHeader(apiKey: string | null): Record<string, string> {
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

export type EndpointKind = "chat_completions" | "simple_chat";

export function endpointFor(baseUrl: string): { url: string; kind: EndpointKind } {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("/api/v1/chat")) {
    return { url: trimmed, kind: "simple_chat" };
  }
  if (lower.endsWith("/v1/chat/completions")) {
    return { url: trimmed, kind: "chat_completions" };
  }
  if (lower.endsWith("/v1")) {
    return { url: `${trimmed}/chat/completions`, kind: "chat_completions" };
  }
  return { url: `${trimmed}/v1/chat/completions`, kind: "chat_completions" };
}

export function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("/v1")) return `${trimmed}/models`;
  if (lower.endsWith("/v1/chat/completions")) {
    return `${trimmed.slice(0, -"/chat/completions".length)}/models`;
  }
  if (lower.endsWith("/api/v1/chat")) {
    return `${trimmed.slice(0, -"/api/v1/chat".length)}/v1/models`;
  }
  return `${trimmed}/v1/models`;
}

export function modelUrlCandidates(baseUrl: string): string[] {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const lower = trimmed.toLowerCase();
  const urls = new Set<string>();
  if (lower.endsWith("/api/v1/chat")) {
    const root = trimmed.slice(0, -"/api/v1/chat".length);
    urls.add(`${root}/api/v1/models`);
    urls.add(`${root}/v1/models`);
  } else if (!lower.endsWith("/v1") && !lower.endsWith("/v1/chat/completions")) {
    urls.add(`${trimmed}/api/v1/models`);
  }
  urls.add(modelsUrl(baseUrl));
  return [...urls];
}
