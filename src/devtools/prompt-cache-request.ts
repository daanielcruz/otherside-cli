import { createHash } from "node:crypto";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const CACHE_TTL_5M_MS = 5 * 60 * 1_000;
const CACHE_TTL_1H_MS = 60 * 60 * 1_000;

export type PromptCacheRole = "main" | "agent" | "title" | "memory_recall" | "auxiliary";

export interface MessageManifest {
  hash: string;
  role: string;
  blockTypes: string[];
  bytes: number;
}

export interface RequestProjection {
  fullBodyHash: string;
  bodyBytes: number;
  topLevelKeys: string[];
  systemHash: string;
  systemCount: number;
  systemBytes: number;
  toolsHash: string;
  toolCount: number;
  toolNames: string[];
  cacheControlHash: string;
  cacheControlCount: number;
  cacheTtlMs: number;
  envelopeHash: string;
  messagesHash: string;
  messages: MessageManifest[];
}

export function projectRequest(body: unknown): RequestProjection {
  const serialized = stringify(body);
  const record = asRecord(body);
  const topLevelKeys = record ? [...new Set(Object.keys(record).map(safeTopLevelKey))].sort() : [];
  const system = pick(record, [
    "system",
    "instructions",
    "systemInstruction",
    "system_instruction",
  ]);
  const tools = pick(record, ["tools"]);
  const messages = pick(record, ["messages", "input", "contents"]);
  const cacheControls: unknown[] = [];
  collectCacheControls(body, cacheControls);
  const envelope = record
    ? Object.fromEntries(
        Object.entries(record).filter(
          ([key]) =>
            ![
              "system",
              "instructions",
              "systemInstruction",
              "system_instruction",
              "tools",
              "messages",
              "input",
              "contents",
            ].includes(key),
        ),
      )
    : body;
  const messageValues = Array.isArray(messages)
    ? messages
    : messages === undefined
      ? []
      : [messages];
  const manifests = messageValues.map(messageManifest);
  const systemValues = Array.isArray(system) ? system : system === undefined ? [] : [system];
  const toolValues = Array.isArray(tools) ? tools : tools === undefined ? [] : [tools];

  return {
    fullBodyHash: hash(serialized),
    bodyBytes: Buffer.byteLength(serialized, "utf8"),
    topLevelKeys,
    systemHash: stableHash(systemValues.map((value) => normalizeMessageValue(value))),
    systemCount: systemValues.length,
    systemBytes: byteLength(systemValues),
    toolsHash: stableHash(toolValues.map((value) => normalizeMessageValue(value))),
    toolCount: toolValues.length,
    toolNames: toolValues.map(toolName).filter((name): name is string => name !== null),
    cacheControlHash: stableHash(cacheControls),
    cacheControlCount: cacheControls.length,
    cacheTtlMs: cacheTtlMs(cacheControls),
    envelopeHash: stableHash(envelope),
    messagesHash: stableHash(messageValues.map((value) => normalizeMessageValue(value))),
    messages: manifests,
  };
}

function messageManifest(value: unknown): MessageManifest {
  const record = asRecord(value);
  const role = stringField(record, "role") ?? stringField(record, "type") ?? "unknown";
  const content = record?.content;
  const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content];
  return {
    hash: stableHash(normalizeMessageValue(value)),
    role: safeVocabulary(role),
    blockTypes: blocks.map(blockType),
    bytes: byteLength(value),
  };
}

function blockType(value: unknown): string {
  if (typeof value === "string") return "text";
  const type = stringField(asRecord(value), "type");
  return type ? safeVocabulary(type) : "unknown";
}

function toolName(value: unknown): string | null {
  const record = asRecord(value);
  const raw = stringField(record, "name") ?? stringField(asRecord(record?.function), "name");
  if (!raw) return null;
  if (raw.startsWith("mcp__")) return "mcp";
  if (/^[A-Z][A-Za-z0-9]{0,63}$/.test(raw)) return raw;
  return `tool:${hash(raw).slice(0, 10)}`;
}

export function promptCacheRole(ctx: RequestContext): PromptCacheRole {
  if (ctx.cacheRole === "title" || ctx.requestRole === "title") return "title";
  if (ctx.requestRole === "memory_recall") return "memory_recall";
  if (ctx.agentic === false) return "auxiliary";
  if (
    ctx.agentId !== undefined ||
    ctx.agentOwnerId !== undefined ||
    ctx.parentThreadId !== undefined ||
    ctx.isForkChild === true
  ) {
    return "agent";
  }
  return "main";
}

export function lineageSource(ctx: RequestContext, role: PromptCacheRole): string {
  if (role === "main") return "main";
  return (
    ctx.agentId ?? ctx.agentOwnerId ?? ctx.parentThreadId ?? ctx.turnId ?? `${role}:${ctx.model}`
  );
}

function collectCacheControls(value: unknown, out: unknown[], seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectCacheControls(item, out, seen);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "cache_control" || key === "cacheControl") out.push(item);
    else collectCacheControls(item, out, seen);
  }
}

function cacheTtlMs(cacheControls: unknown[]): number {
  const hasExtendedTtl = cacheControls.some(
    (control) => stringField(asRecord(control), "ttl") === "1h",
  );
  return hasExtendedTtl ? CACHE_TTL_1H_MS : CACHE_TTL_5M_MS;
}

export function commonPrefixLength(
  previous: MessageManifest[],
  current: MessageManifest[],
): number {
  const count = Math.min(previous.length, current.length);
  let index = 0;
  while (index < count && previous[index]?.hash === current[index]?.hash) index += 1;
  return index;
}

function pick(record: Record<string, unknown> | null, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function stableHash(value: unknown): string {
  return hash(stringify(normalizeCacheValue(value)));
}

function normalizeMessageValue(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeMessageValue(item));
  const record = asRecord(value);
  if (!record) return normalizeCacheValue(value, key);
  return Object.fromEntries(
    Object.keys(record)
      .filter((field) => field !== "cache_control" && field !== "cacheControl")
      .sort()
      .map((field) => [field, normalizeMessageValue(record[field], field)]),
  );
}

function normalizeCacheValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (keyMatchesVolatileId(key)) return "<volatile-id>";
    if (value.includes("x-anthropic-billing-header:")) {
      return value
        .replace(/\bcch=[^;\s]+/g, "cch=<volatile>")
        .replace(/\bcc_prev_req=[^;\s]+/g, "cc_prev_req=<volatile>");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeCacheValue(item));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((field) => [field, normalizeCacheValue(record[field], field)]),
  );
}

function keyMatchesVolatileId(key: string): boolean {
  return /^(?:request_?id|response_?request_?id|previous_?(?:message|response)_?id)$/i.test(key);
}

function safeTopLevelKey(value: string): string {
  if (/api.?key|auth|cookie|credential|password|secret|token/i.test(value)) return "redacted";
  return safeVocabulary(value);
}

function safeVocabulary(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? value : `value:${hash(value).slice(0, 10)}`;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(stringify(value), "utf8");
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "<unserializable>";
  }
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
