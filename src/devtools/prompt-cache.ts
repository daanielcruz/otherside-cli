import { createHash } from "node:crypto";
import { diagnosticPath, isStreamEnabled, writeDiagnostic } from "@/devtools/diagnostics.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const MIN_CACHE_MISS_TOKENS = 2_000;
const MIN_EXPECTED_REUSE_RATIO = 0.95;
const CACHE_TTL_5M_MS = 5 * 60 * 1_000;
const CACHE_TTL_1H_MS = 60 * 60 * 1_000;
const MAX_TRACKED_LINEAGES = 10;

export type PromptCacheClassification =
  | "baseline"
  | "healthy"
  | "suspected_break"
  | "explained_break"
  | "excluded"
  | "insufficient_metrics";

type PromptCacheRole = "main" | "agent" | "title" | "memory_recall" | "auxiliary";
type AttemptOutcome = "completed" | "transport_error" | "aborted";

interface CacheMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

interface MessageManifest {
  hash: string;
  role: string;
  blockTypes: string[];
  bytes: number;
}

interface RequestProjection {
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

interface CacheBaseline {
  sequence: number;
  finishedAtMs: number;
  provider: string;
  model: string;
  projection: RequestProjection;
  metrics: CacheMetrics;
}

export interface PromptCacheAttempt {
  sequence: number;
  attempt: number;
  resumed: boolean;
  startedAtMs: number;
  role: PromptCacheRole;
  comparable: boolean;
  trackingKey: string;
  lineage: string;
  sessionId: string;
  sessionHash: string;
  provider: string;
  model: string;
  effort: string | null;
  fastMode: boolean;
  projection: RequestProjection;
  metrics: CacheMetrics;
  requestId?: string;
  messageId?: string;
  stopReason?: string;
  finished: boolean;
}

interface PromptCacheComparison {
  previousSequence?: number;
  expectedCacheReadTokens?: number;
  actualCacheReadTokens?: number;
  missingCacheReadTokens?: number;
  reuseRatio?: number;
  gapMs?: number;
  cacheTtlMs?: number;
  commonMessagePrefix: number;
  changes: string[];
}

export interface PromptCacheDiagnosticRecord {
  at: string;
  event: "prompt_cache_attempt";
  sequence: number;
  attempt: number;
  outcome: AttemptOutcome;
  classification: PromptCacheClassification;
  reasonCodes: string[];
  session: string;
  lineage: string;
  role: PromptCacheRole;
  provider: string;
  model: string;
  effort: string | null;
  fastMode: boolean;
  resumed: boolean;
  request: {
    bodyBytes: number;
    bodyHash: string;
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
  };
  response: CacheMetrics & {
    requestId?: string;
    messageId?: string;
    stopReason?: string;
  };
  comparison: PromptCacheComparison;
}

type DiagnosticSink = (sessionId: string, record: PromptCacheDiagnosticRecord) => void;

let states: Map<string, CacheBaseline> | undefined;
let sequence = 0;
let diagnosticSink: DiagnosticSink = (sessionId, record) => {
  writeDiagnostic(diagnosticPath({ stream: "prompt-cache", sessionId }), record);
};

export function beginPromptCacheAttempt(input: {
  ctx: RequestContext;
  body: unknown;
  attempt: number;
  resumed: boolean;
  nowMs?: number;
}): PromptCacheAttempt | null {
  if (!isStreamEnabled("prompt-cache")) return null;

  try {
    const role = promptCacheRole(input.ctx);
    const source = lineageSource(input.ctx, role);
    const sessionHash = hash(input.ctx.sessionId).slice(0, 16);
    sequence += 1;
    return {
      sequence,
      attempt: input.attempt,
      resumed: input.resumed,
      startedAtMs: input.nowMs ?? Date.now(),
      role,
      comparable: role === "main" || role === "agent",
      trackingKey: `${input.ctx.sessionId}\0${source}`,
      lineage: role === "main" ? "main" : `${role}:${hash(source).slice(0, 12)}`,
      sessionId: input.ctx.sessionId,
      sessionHash,
      provider: input.ctx.provider,
      model: input.ctx.model,
      effort: input.ctx.effort,
      fastMode: input.ctx.fastMode === true,
      projection: projectRequest(input.body),
      metrics: {},
      finished: false,
    };
  } catch {
    return null;
  }
}

export function recordPromptCacheEvent(
  attempt: PromptCacheAttempt | null,
  event: ProviderEvent,
): void {
  if (!attempt || attempt.finished) return;
  if (event.kind === "usage") {
    assignMetric(attempt.metrics, "inputTokens", event.inputTokens);
    assignMetric(attempt.metrics, "outputTokens", event.outputTokens);
    assignMetric(attempt.metrics, "cacheCreationInputTokens", event.cacheCreationInputTokens);
    assignMetric(attempt.metrics, "cacheReadInputTokens", event.cacheReadInputTokens);
    return;
  }
  if (event.kind === "message_start") {
    if (event.requestId !== undefined) attempt.requestId = event.requestId;
    if (event.id !== undefined) attempt.messageId = event.id;
    return;
  }
  if (event.kind === "message_stop") {
    attempt.stopReason = event.stop_reason;
    return;
  }
  if (event.kind === "error" || event.kind === "quota_exhausted") {
    attempt.stopReason ??= "error";
  }
}

export function finishPromptCacheAttempt(
  attempt: PromptCacheAttempt | null,
  outcome: AttemptOutcome,
  nowMs = Date.now(),
): void {
  if (!attempt || attempt.finished) return;
  attempt.finished = true;

  try {
    const result = classifyAttempt(attempt, outcome, nowMs);
    diagnosticSink(attempt.sessionId, {
      at: new Date(nowMs).toISOString(),
      event: "prompt_cache_attempt",
      sequence: attempt.sequence,
      attempt: attempt.attempt,
      outcome,
      classification: result.classification,
      reasonCodes: result.reasonCodes,
      session: attempt.sessionHash,
      lineage: attempt.lineage,
      role: attempt.role,
      provider: attempt.provider,
      model: attempt.model,
      effort: attempt.effort,
      fastMode: attempt.fastMode,
      resumed: attempt.resumed,
      request: {
        bodyBytes: attempt.projection.bodyBytes,
        bodyHash: attempt.projection.fullBodyHash,
        topLevelKeys: attempt.projection.topLevelKeys,
        systemHash: attempt.projection.systemHash,
        systemCount: attempt.projection.systemCount,
        systemBytes: attempt.projection.systemBytes,
        toolsHash: attempt.projection.toolsHash,
        toolCount: attempt.projection.toolCount,
        toolNames: attempt.projection.toolNames,
        cacheControlHash: attempt.projection.cacheControlHash,
        cacheControlCount: attempt.projection.cacheControlCount,
        cacheTtlMs: attempt.projection.cacheTtlMs,
        envelopeHash: attempt.projection.envelopeHash,
        messagesHash: attempt.projection.messagesHash,
        messages: attempt.projection.messages,
      },
      response: {
        ...attempt.metrics,
        ...(attempt.requestId !== undefined ? { requestId: attempt.requestId } : {}),
        ...(attempt.messageId !== undefined ? { messageId: attempt.messageId } : {}),
        ...(attempt.stopReason !== undefined ? { stopReason: attempt.stopReason } : {}),
      },
      comparison: result.comparison,
    });
  } catch {}
}

export function resetPromptCacheDiagnosticsForTests(): void {
  states = undefined;
  sequence = 0;
  diagnosticSink = (sessionId, record) => {
    writeDiagnostic(diagnosticPath({ stream: "prompt-cache", sessionId }), record);
  };
}

export function setPromptCacheDiagnosticSinkForTests(sink: DiagnosticSink): void {
  diagnosticSink = sink;
}

function classifyAttempt(
  attempt: PromptCacheAttempt,
  outcome: AttemptOutcome,
  nowMs: number,
): {
  classification: PromptCacheClassification;
  reasonCodes: string[];
  comparison: PromptCacheComparison;
} {
  const baselines = states;
  const baseline = baselines?.get(attempt.trackingKey);
  const comparison = compareRequests(baseline, attempt, nowMs);

  if (outcome !== "completed") {
    return {
      classification: "excluded",
      reasonCodes: [outcome],
      comparison,
    };
  }
  if (attempt.resumed) {
    return {
      classification: "excluded",
      reasonCodes: ["resumed_stream"],
      comparison,
    };
  }
  if (!attempt.comparable) {
    return {
      classification: "excluded",
      reasonCodes: [`role_${attempt.role}`],
      comparison,
    };
  }
  if (attempt.stopReason === undefined) {
    return {
      classification: "excluded",
      reasonCodes: ["stream_not_terminal"],
      comparison,
    };
  }
  if (attempt.stopReason === "refusal" || attempt.stopReason === "error") {
    return {
      classification: "excluded",
      reasonCodes: [attempt.stopReason],
      comparison,
    };
  }
  const cacheRead = attempt.metrics.cacheReadInputTokens;
  if (cacheRead === undefined) {
    return {
      classification: "insufficient_metrics",
      reasonCodes: ["cache_read_unavailable"],
      comparison,
    };
  }
  if (!baseline) {
    promoteBaseline(attempt, nowMs);
    return {
      classification: "baseline",
      reasonCodes: ["first_comparable_request"],
      comparison,
    };
  }

  const expectedRead = expectedCacheRead(baseline.metrics);
  if (expectedRead === undefined || expectedRead < MIN_CACHE_MISS_TOKENS) {
    promoteBaseline(attempt, nowMs);
    return {
      classification: "insufficient_metrics",
      reasonCodes: ["expected_cache_below_minimum"],
      comparison,
    };
  }

  const missing = expectedRead - cacheRead;
  const qualifyingDrop =
    cacheRead < expectedRead * MIN_EXPECTED_REUSE_RATIO && missing >= MIN_CACHE_MISS_TOKENS;
  if (!qualifyingDrop) {
    promoteBaseline(attempt, nowMs);
    return {
      classification: "healthy",
      reasonCodes: ["cache_reuse_within_threshold"],
      comparison,
    };
  }

  const ttlExpired = (comparison.gapMs ?? 0) > baseline.projection.cacheTtlMs;
  if (comparison.changes.length > 0 || ttlExpired) {
    promoteBaseline(attempt, nowMs);
    return {
      classification: "explained_break",
      reasonCodes: [...comparison.changes, ...(ttlExpired ? ["cache_ttl_expired"] : [])],
      comparison,
    };
  }

  if ((attempt.metrics.cacheCreationInputTokens ?? 0) > 0) promoteBaseline(attempt, nowMs);
  return {
    classification: "suspected_break",
    reasonCodes: ["stable_prefix_cache_drop"],
    comparison,
  };
}

function compareRequests(
  baseline: CacheBaseline | undefined,
  attempt: PromptCacheAttempt,
  nowMs: number,
): PromptCacheComparison {
  if (!baseline) {
    return { commonMessagePrefix: 0, changes: [] };
  }

  const expectedRead = expectedCacheRead(baseline.metrics);
  const actualRead = attempt.metrics.cacheReadInputTokens;
  const commonMessagePrefix = commonPrefixLength(
    baseline.projection.messages,
    attempt.projection.messages,
  );
  const changes: string[] = [];
  if (baseline.provider !== attempt.provider) changes.push("provider_changed");
  if (baseline.model !== attempt.model) changes.push("model_changed");
  if (baseline.projection.systemHash !== attempt.projection.systemHash)
    changes.push("system_changed");
  if (baseline.projection.toolsHash !== attempt.projection.toolsHash) changes.push("tools_changed");
  if (baseline.projection.cacheControlHash !== attempt.projection.cacheControlHash)
    changes.push("cache_control_changed");
  if (baseline.projection.envelopeHash !== attempt.projection.envelopeHash)
    changes.push("envelope_changed");
  if (
    commonMessagePrefix !== baseline.projection.messages.length ||
    attempt.projection.messages.length < baseline.projection.messages.length
  ) {
    changes.push("message_prefix_rewritten");
  }

  return {
    previousSequence: baseline.sequence,
    ...(expectedRead !== undefined ? { expectedCacheReadTokens: expectedRead } : {}),
    ...(actualRead !== undefined ? { actualCacheReadTokens: actualRead } : {}),
    ...(expectedRead !== undefined && actualRead !== undefined
      ? {
          missingCacheReadTokens: Math.max(0, expectedRead - actualRead),
          reuseRatio: expectedRead === 0 ? 1 : actualRead / expectedRead,
        }
      : {}),
    gapMs: Math.max(0, nowMs - baseline.finishedAtMs),
    cacheTtlMs: baseline.projection.cacheTtlMs,
    commonMessagePrefix,
    changes,
  };
}

function expectedCacheRead(metrics: CacheMetrics): number | undefined {
  const read = metrics.cacheReadInputTokens;
  if (read === undefined) return undefined;
  return read + (metrics.cacheCreationInputTokens ?? 0);
}

function promoteBaseline(attempt: PromptCacheAttempt, nowMs: number): void {
  states ??= new Map();
  if (!states.has(attempt.trackingKey)) {
    while (states.size >= MAX_TRACKED_LINEAGES) {
      const oldest = states.keys().next().value;
      if (oldest === undefined) break;
      states.delete(oldest);
    }
  }
  states.set(attempt.trackingKey, {
    sequence: attempt.sequence,
    finishedAtMs: nowMs,
    provider: attempt.provider,
    model: attempt.model,
    projection: attempt.projection,
    metrics: { ...attempt.metrics },
  });
}

function projectRequest(body: unknown): RequestProjection {
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

function promptCacheRole(ctx: RequestContext): PromptCacheRole {
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

function lineageSource(ctx: RequestContext, role: PromptCacheRole): string {
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

function commonPrefixLength(previous: MessageManifest[], current: MessageManifest[]): number {
  const count = Math.min(previous.length, current.length);
  let index = 0;
  while (index < count && previous[index]?.hash === current[index]?.hash) index += 1;
  return index;
}

function assignMetric(
  target: CacheMetrics,
  key: keyof CacheMetrics,
  value: number | undefined,
): void {
  if (value !== undefined) target[key] = value;
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
