import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

export interface WebSearchInput {
  query: string;
  allowedDomains: string[];
  blockedDomains: string[];
}

export interface WebSearchHit {
  title: string;
  url: string;
}

export interface WebSearchPayload {
  query: string;
  provider: ProviderId;
  results: Array<string | WebSearchHit | Record<string, unknown>>;
  durationSeconds: number;
}

export function invalid(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

export function parseInput(call: ToolCall): WebSearchInput | string {
  const args = (call.input ?? {}) as Record<string, unknown>;
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length < 2) return "query is required (min 2 chars)";
  const allowed = parseDomains(args.allowed_domains, "allowed_domains");
  if (typeof allowed === "string") return allowed;
  const blocked = parseDomains(args.blocked_domains, "blocked_domains");
  if (typeof blocked === "string") return blocked;
  if (allowed.length > 0 && blocked.length > 0) {
    return "Cannot specify both allowed_domains and blocked_domains in the same request";
  }
  return { query, allowedDomains: allowed, blockedDomains: blocked };
}

function parseDomains(value: unknown, field: string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${field} must be an array of strings`;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return `${field} must be an array of strings`;
    }
    out.push(item.trim().toLowerCase());
  }
  return out;
}

export function filterResults<T extends { url: string }>(
  results: T[],
  allowedDomains: readonly string[],
  blockedDomains: readonly string[],
): T[] {
  return results.filter((result) => {
    const host = hostOf(result.url);
    if (!host) return false;
    if (allowedDomains.length > 0) {
      return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    }
    if (blockedDomains.length > 0) {
      return !blockedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    }
    return true;
  });
}

export function dedupeByUrl<T extends { url: string }>(hits: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const hit of hits) {
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    out.push(hit);
  }
  return out;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
