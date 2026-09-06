import type { TransformedMcpResult } from "@/kernel/mcp/client/output/handler.ts";

export interface LineMeta {
  count: number;
  maxLen: number;
}

const DEFAULT_SHAPE_DEPTH = 2;
const DISPLAYED_MEMBER_LIMIT = 10;
const BYTES_PER_UNIT = 1024;

export function formatDescription(result: TransformedMcpResult): string {
  switch (result.type) {
    case "toolResult":
      return "Plain text";
    case "structuredContent":
      return describeJsonFormat("JSON", result.schema);
    default:
      return describeJsonFormat("JSON array", result.schema);
  }
}

function describeJsonFormat(formatKind: string, sampleShape: string | undefined): string {
  return sampleShape ? `${formatKind} with schema: ${sampleShape}` : formatKind;
}

export function inferCompactSchema(sample: unknown, remainingDepth = DEFAULT_SHAPE_DEPTH): string {
  if (sample === null) return "null";
  if (Array.isArray(sample)) return describeListSample(sample, remainingDepth);

  if (typeof sample !== "object") return typeof sample;
  if (remainingDepth <= 0) return "{...}";

  return describeObjectSample(sample, remainingDepth);
}

function describeListSample(sample: unknown[], remainingDepth: number): string {
  if (sample.length === 0) return "[]";
  const firstShape = inferCompactSchema(sample[0], remainingDepth - 1);
  return `[${firstShape}]`;
}

function describeObjectSample(sample: object, remainingDepth: number): string {
  const displayedMembers = Object.entries(sample).slice(0, DISPLAYED_MEMBER_LIMIT);
  const memberDescriptions: string[] = [];

  for (const [propertyName, memberSample] of displayedMembers) {
    const memberShape = inferCompactSchema(memberSample, remainingDepth - 1);
    memberDescriptions.push(`${propertyName}: ${memberShape}`);
  }

  const hasHiddenMembers = Object.keys(sample).length > DISPLAYED_MEMBER_LIMIT;
  const continuation = hasHiddenMembers ? ", ..." : "";
  return `{${memberDescriptions.join(", ")}${continuation}}`;
}

export function lineMetaFor(content: string): LineMeta {
  const withoutTerminalBreak = content.endsWith("\n") ? content.slice(0, -1) : content;
  const segments = withoutTerminalBreak.split("\n");
  let longestLine = 0;

  for (const segment of segments) {
    longestLine = Math.max(longestLine, segment.length);
  }

  return { count: segments.length, maxLen: longestLine };
}

export function formatFileSize(size: number): string {
  const kibibytes = size / BYTES_PER_UNIT;
  if (kibibytes < 1) return `${size} bytes`;
  if (kibibytes < BYTES_PER_UNIT) return `${conciseDecimal(kibibytes)}KB`;

  const mebibytes = kibibytes / BYTES_PER_UNIT;
  if (mebibytes < BYTES_PER_UNIT) return `${conciseDecimal(mebibytes)}MB`;

  const gibibytes = mebibytes / BYTES_PER_UNIT;
  return `${conciseDecimal(gibibytes)}GB`;
}

function conciseDecimal(quantity: number): string {
  const fixed = quantity.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}
