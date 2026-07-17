import { wrapAnsi } from "@/ink";
import { prettyJson } from "@/kernel/std/text/json-display.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import { GUTTER_CONT } from "@/ui/theme/theme.ts";

// Collapse a string to one terminal-safe line: newlines/tabs/other C0 controls
// become a space and `\r\b\v\f`/DEL are dropped, so a raw `\r` or ESC in tool
// args can't corrupt the row or inject terminal sequences. Off the ANSI path —
// previews carry raw args, never styled output.
function flattenForPreview(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\r" || ch === "\b" || ch === "\v" || ch === "\f") continue;
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

export function clipFlat(s: string, max: number): string {
  const flat = flattenForPreview(s);
  const arr = [...flat];
  if (arr.length <= max) return flat;
  return `${arr.slice(0, Math.max(0, max - 1)).join("")}…`;
}

export function expandTabsForRender(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\t") out += "    ";
    else if (ch === "\r" || ch === "\b" || ch === "\v" || ch === "\f") continue;
    else if (ch.charCodeAt(0) < 0x20) out += " ";
    else out += ch;
  }
  return out;
}

export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const parts = content.split("\n").length;
  return content.endsWith("\n") ? parts - 1 : parts;
}

export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function trimMultiline(s: string, maxLines: number, maxChars: number): string {
  const all = s.trimEnd().split("\n");
  const total = all.length;
  const out: string[] = [];
  for (const line of all.slice(0, maxLines)) {
    const arr = [...line];
    out.push(arr.length > maxChars ? `${arr.slice(0, maxChars - 1).join("")}…` : line);
  }
  if (total > maxLines) {
    const remaining = total - maxLines;
    out.push(`… (${remaining} more line${remaining === 1 ? "" : "s"})`);
  }
  return out.join("\n");
}

export function oneLinePreview(s: string, max: number): string {
  return clipFlat(s, max);
}

export const JSON_FORMAT_MAX_LENGTH = 10_000;

export function tryFormatJsonContent(content: string): string {
  if (content.length > JSON_FORMAT_MAX_LENGTH) return content;
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return line;
      try {
        return prettyJson(JSON.parse(line));
      } catch {
        return line;
      }
    })
    .join("\n");
}

// Tab-expand + drop the destructive control chars (\r\b\v\f), but PRESERVE the
// ESC (0x1b) so the <Ansi> renderer can parse shell colour sequences into
// styled spans. Other sub-0x20 controls still collapse to a space.
function expandTabsPreservingAnsi(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\t") out += "    ";
    else if (ch === "\r" || ch === "\b" || ch === "\v" || ch === "\f") continue;
    else if (ch === "\x1b") out += ch;
    else if (ch.charCodeAt(0) < 0x20) out += " ";
    else out += ch;
  }
  return out;
}

export function wrapShellOutput(text: string, width: number): string[] {
  const wrapWidth = Math.max(width - GUTTER_CONT.length, 10);
  const wrapped: string[] = [];
  for (const raw of text.replace(/\n+$/, "").split("\n")) {
    const line = expandTabsPreservingAnsi(raw);
    // wrapAnsi measures VISIBLE width, so ANSI escape bytes never skew the wrap
    // and a colour sequence is never split mid-escape. hard breaks over-long
    // tokens; wordWrap off mirrors the old byte-slice; trim off keeps shell
    // whitespace intact.
    const w = wrapAnsi(line, wrapWidth, { hard: true, wordWrap: false, trim: false });
    for (const piece of w.split("\n")) wrapped.push(piece);
  }
  return wrapped;
}

export function formatByteSize(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

export function formatDurationMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export const MCP_WARNING_THRESHOLD_TOKENS = 10_000;
export const CHARS_PER_TOKEN = 4;

export function mcpSizeWarning(content: string): string | null {
  const estimatedTokens = Math.round(content.length / CHARS_PER_TOKEN);
  if (estimatedTokens <= MCP_WARNING_THRESHOLD_TOKENS) return null;
  const compact = `~${Math.round(estimatedTokens / 1000)}k`;
  return `⚠ Large MCP response (${compact} tokens), this can fill up context quickly`;
}

export const UNWRAP_MIN_STRING_LEN = 200;
export const UNWRAP_MULTILINE_MIN_LEN = 50;
export const UNWRAP_EXTRA_MAX_LEN = 150;
export const UNWRAP_MAX_KEYS = 4;
export const FLATTEN_NESTED_MAX_LEN = 120;
export const FLATTEN_MAX_KEYS = 12;
export const FLATTEN_MAX_CHARS = 5_000;
export const JSON_PARSE_MAX_CHARS = 200_000;

export interface UnwrappedTextPayload {
  body: string;
  extras: [string, string][];
}

export function parseJsonEntries(
  content: string,
  options: { maxChars: number; maxKeys: number },
): [string, unknown][] | null {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > options.maxChars || trimmed[0] !== "{") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > options.maxKeys) return null;
  return entries;
}

export function tryUnwrapTextPayload(content: string): UnwrappedTextPayload | null {
  const entries = parseJsonEntries(content, {
    maxChars: JSON_PARSE_MAX_CHARS,
    maxKeys: UNWRAP_MAX_KEYS,
  });
  if (entries === null) return null;
  let body: string | null = null;
  const extras: [string, string][] = [];
  for (const [key, value] of entries) {
    if (typeof value === "string") {
      const trimmed = value.trimEnd();
      const dominant =
        trimmed.length > UNWRAP_MIN_STRING_LEN ||
        (trimmed.includes("\n") && trimmed.length > UNWRAP_MULTILINE_MIN_LEN);
      if (dominant) {
        if (body !== null) return null;
        body = trimmed;
        continue;
      }
      if (trimmed.length > UNWRAP_EXTRA_MAX_LEN) return null;
      extras.push([key, trimmed.replace(/\s+/g, " ")]);
      continue;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      extras.push([key, String(value)]);
      continue;
    }
    return null;
  }
  if (body === null) return null;
  return { body, extras };
}

export function tryFlattenJson(content: string): [string, string][] | null {
  const entries = parseJsonEntries(content, {
    maxChars: FLATTEN_MAX_CHARS,
    maxKeys: FLATTEN_MAX_KEYS,
  });
  if (entries === null) return null;
  const result: [string, string][] = [];
  for (const [key, value] of entries) {
    if (typeof value === "string") {
      result.push([key, value]);
      continue;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      result.push([key, String(value)]);
      continue;
    }
    if (typeof value === "object") {
      const compact = JSON.stringify(value);
      if (compact.length > FLATTEN_NESTED_MAX_LEN) return null;
      result.push([key, compact]);
      continue;
    }
    return null;
  }
  return result;
}
