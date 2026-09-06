import { createHash } from "node:crypto";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendDiagnosticLine, diagnosticPath, isStreamEnabled } from "@/devtools/diagnostics.ts";
import {
  type ByteSilenceEvent,
  setByteSilenceListener,
  setDelayedByteSilenceListener,
} from "@/kernel/std/stream/idle-timeout.ts";

const SENTINEL = "OTHERSIDE_STREAM_DEBUG_V1";
const MAX_FILES = 50;
const BODY_PREVIEW_BYTES = 200;

const SCRUB_PATTERNS: Array<{ re: RegExp; sub: string }> = [
  { re: /(authorization\s*:\s*)[^\r\n]+/gi, sub: "$1[REDACTED]" },
  { re: /(x-api-key\s*:\s*)[^\r\n]+/gi, sub: "$1[REDACTED]" },
  { re: /(cookie\s*:\s*)[^\r\n]+/gi, sub: "$1[REDACTED]" },
  { re: /(bearer\s+)[A-Za-z0-9._\-+/=]+/gi, sub: "$1[REDACTED]" },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, sub: "[email]" },
  { re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, sub: "[cpf]" },
  { re: /sk-[A-Za-z0-9_-]{20,}/g, sub: "[apikey]" },
  { re: /ya29\.[A-Za-z0-9_-]+/g, sub: "[ya29]" },
  {
    re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
    sub: "[jwt]",
  },
];

export function isStreamDebugCaptureEnabled(): boolean {
  return isStreamEnabled("stream-close");
}

function debugRoot(): string {
  return dirname(dirname(diagnosticPath({ stream: "stream-close", sessionId: "__probe__" })));
}

export function scrubForDebug(input: string): string {
  let out = input;
  for (const { re, sub } of SCRUB_PATTERNS) out = out.replace(re, sub);
  return out;
}

function bodyPreview(body: string | null | undefined): string | null {
  if (!body) return null;
  const slice = body.length > BODY_PREVIEW_BYTES ? body.slice(0, BODY_PREVIEW_BYTES) : body;
  const scrubbed = scrubForDebug(slice);
  return Buffer.from(scrubbed, "utf8").toString("base64");
}

function headersHash(headers: Record<string, string> | null | undefined): string | null {
  if (!headers) return null;
  const normalized = Object.entries(headers)
    .map(([k, v]) => `${k.toLowerCase()}=${v}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}

function rotate(dir: string): void {
  const files: Array<{ f: string; mtime: number }> = [];
  let sessionDirs: string[] = [];
  try {
    sessionDirs = readdirSync(dir);
  } catch {
    return;
  }
  for (const sub of sessionDirs) {
    const subDir = join(dir, sub);
    let entries: string[] = [];
    try {
      entries = readdirSync(subDir).filter(
        (f) => f.startsWith("stream-close") && f.endsWith(".jsonl"),
      );
    } catch {
      continue;
    }
    for (const f of entries) {
      const full = join(subDir, f);
      try {
        files.push({ f: full, mtime: statSync(full).mtimeMs });
      } catch {}
    }
  }
  if (files.length <= MAX_FILES) return;
  files.sort((a, b) => a.mtime - b.mtime);
  const toDrop = files.slice(0, files.length - MAX_FILES);
  for (const { f } of toDrop) {
    try {
      unlinkSync(f);
    } catch {}
  }
}

const sessionPaths = new Map<string, string>();
const sessionSentinelWritten = new Set<string>();

function resolveLogPath(provider: string, sessionId: string): string {
  const sessionKey = `${provider}::${sessionId}`;
  const cached = sessionPaths.get(sessionKey);
  if (cached) return cached;
  const safeProvider = provider.replace(/[^a-z0-9_-]/gi, "_").slice(0, 32);
  const safeSession = sessionId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 32);
  const path = diagnosticPath({
    stream: "stream-close",
    sessionId: `${safeProvider}__${safeSession}`,
    suffix: process.pid.toString(),
  });
  sessionPaths.set(sessionKey, path);
  return path;
}

function writeLine(path: string, record: Record<string, unknown>): void {
  const fresh = !sessionSentinelWritten.has(path);
  if (fresh) {
    appendDiagnosticLine(path, SENTINEL);
    sessionSentinelWritten.add(path);
  }
  appendDiagnosticLine(path, JSON.stringify(record));
  if (fresh) rotate(debugRoot());
}

export interface StreamCloseContext {
  provider: string;
  model: string;
  sessionId: string;
  requestId?: string | null;
  requestUrl?: string | null;
  requestHeaders?: Record<string, string> | null;
  bodyPreview?: string | null;
  elapsedMsSinceRequestStart?: number | null;
  lastFrameKind?: string | null;
}

interface BaseRecord {
  ts: string;
  kind: string;
  provider: string;
  model: string;
  sessionId: string;
  requestId: string | null;
  requestUrl: string | null;
  requestHeadersHash: string | null;
  bodyPreviewBase64: string | null;
  elapsedMsSinceRequestStart: number | null;
  lastFrameKind: string | null;
}

function baseRecord(ctx: StreamCloseContext, kind: string): BaseRecord {
  return {
    ts: new Date().toISOString(),
    kind,
    provider: ctx.provider,
    model: ctx.model,
    sessionId: ctx.sessionId,
    requestId: ctx.requestId ?? null,
    requestUrl: ctx.requestUrl ?? null,
    requestHeadersHash: headersHash(ctx.requestHeaders),
    bodyPreviewBase64: bodyPreview(ctx.bodyPreview),
    elapsedMsSinceRequestStart: ctx.elapsedMsSinceRequestStart ?? null,
    lastFrameKind: ctx.lastFrameKind ?? null,
  };
}

export function recordIdleTimeout(
  ctx: StreamCloseContext,
  event: ByteSilenceEvent & { lastChunkAgeMs?: number },
): void {
  if (!isStreamDebugCaptureEnabled()) return;
  const path = resolveLogPath(ctx.provider, ctx.sessionId);
  writeLine(path, {
    ...baseRecord(ctx, "idle_timeout"),
    timeoutMs: event.limitMs,
    lateMs: event.delayedByMs,
    bytesTotal: event.bytesSeen,
    readableErrored: event.outputClosed,
    lastChunkAgeMs: event.lastChunkAgeMs ?? null,
  });
}

export function recordPrematureClose(
  ctx: StreamCloseContext,
  detail: { sawContent: boolean; lastEvent: string | null },
): void {
  if (!isStreamDebugCaptureEnabled()) return;
  const path = resolveLogPath(ctx.provider, ctx.sessionId);
  writeLine(path, {
    ...baseRecord(ctx, "premature_close"),
    sawContent: detail.sawContent,
    lastEvent: detail.lastEvent,
  });
}

export function recordRetrySuppressed(
  ctx: StreamCloseContext,
  detail: { decisionReason: string; emittedContent: boolean },
): void {
  if (!isStreamDebugCaptureEnabled()) return;
  const path = resolveLogPath(ctx.provider, ctx.sessionId);
  writeLine(path, {
    ...baseRecord(ctx, "retry_suppressed_mid_content"),
    decisionReason: detail.decisionReason,
    emittedContent: detail.emittedContent,
  });
}

let watchdogContextProvider: (() => StreamCloseContext | null) | null = null;

export function setWatchdogContextProvider(fn: (() => StreamCloseContext | null) | null): void {
  watchdogContextProvider = fn;
}

export function installWatchdogCaptureHooks(): void {
  setByteSilenceListener((event) => {
    if (!isStreamDebugCaptureEnabled()) return;
    const ctx = watchdogContextProvider?.();
    if (!ctx) return;
    recordIdleTimeout(ctx, event);
  });
  setDelayedByteSilenceListener(() => {});
}

export interface DebugCaptureSummary {
  totalRecords: number;
  byKind: Record<string, number>;
  byProvider: Record<string, number>;
  windowHours: number;
}

export function summarizeDebugCaptures(windowHours = 24): DebugCaptureSummary {
  const dir = debugRoot();
  const since = Date.now() - windowHours * 3600 * 1000;
  const summary: DebugCaptureSummary = {
    totalRecords: 0,
    byKind: {},
    byProvider: {},
    windowHours,
  };
  let sessionDirs: string[] = [];
  try {
    sessionDirs = readdirSync(dir);
  } catch {
    return summary;
  }
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  for (const sub of sessionDirs) {
    const subDir = join(dir, sub);
    let entries: string[] = [];
    try {
      entries = readdirSync(subDir).filter(
        (f) => f.startsWith("stream-close") && f.endsWith(".jsonl"),
      );
    } catch {
      continue;
    }
    for (const f of entries) {
      const path = join(subDir, f);
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < since) continue;
      let raw = "";
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line || line === SENTINEL) continue;
        let rec: Record<string, unknown> | null = null;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (!rec) continue;
        summary.totalRecords += 1;
        const kind = typeof rec.kind === "string" ? rec.kind : "unknown";
        const provider = typeof rec.provider === "string" ? rec.provider : "unknown";
        summary.byKind[kind] = (summary.byKind[kind] ?? 0) + 1;
        summary.byProvider[provider] = (summary.byProvider[provider] ?? 0) + 1;
      }
    }
  }
  return summary;
}
