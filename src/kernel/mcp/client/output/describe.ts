import type { TransformedMcpResult } from "@/kernel/mcp/client/output/handler.ts";

export interface LineMeta {
  count: number;
  maxLen: number;
}

export function formatDescription(result: TransformedMcpResult): string {
  if (result.type === "toolResult") return "Plain text";
  if (result.type === "structuredContent")
    return result.schema ? `JSON with schema: ${result.schema}` : "JSON";
  return result.schema ? `JSON array with schema: ${result.schema}` : "JSON array";
}

export function inferCompactSchema(value: unknown, depth = 2): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${inferCompactSchema(value[0], depth - 1)}]`;
  }
  if (typeof value === "object" && value !== null) {
    if (depth <= 0) return "{...}";
    const entries = Object.entries(value).slice(0, 10);
    const props = entries.map(
      ([key, entryValue]) => `${key}: ${inferCompactSchema(entryValue, depth - 1)}`,
    );
    const suffix = Object.keys(value).length > 10 ? ", ..." : "";
    return `{${props.join(", ")}${suffix}}`;
  }
  return typeof value;
}

export function lineMetaFor(content: string): LineMeta | undefined {
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  if (lines.length <= 1) return { count: lines.length, maxLen: lines[0]?.length ?? 0 };
  return {
    count: lines.length,
    maxLen: lines.reduce((max, line) => Math.max(max, line.length), 0),
  };
}

export function formatFileSize(sizeInBytes: number): string {
  const kb = sizeInBytes / 1024;
  if (kb < 1) return `${sizeInBytes} bytes`;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, "")}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, "")}MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1).replace(/\.0$/, "")}GB`;
}
