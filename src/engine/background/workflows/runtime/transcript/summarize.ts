import { truncateEllipsis } from "@/kernel/std/text/text.ts";

const TOOL_SUMMARY_MAX = 60;
const SUMMARY_KEY_PRECEDENCE = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "prompt",
] as const;

function condense(value: string): string {
  return truncateEllipsis(value.replace(/\s+/g, " ").trim(), TOOL_SUMMARY_MAX);
}

export function summarizeToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record: Record<string, unknown> = Object(input);
  for (const key of SUMMARY_KEY_PRECEDENCE) {
    const value = record[key];
    if (typeof value === "string") return condense(value);
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string") return condense(value);
  }
  return "";
}
