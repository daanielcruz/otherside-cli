import { parseWorkflowScript } from "@/engine/background/workflows/runtime/parser/meta.ts";
import { WorkflowParseError } from "@/engine/background/workflows/runtime/parser/types.ts";

const NAMED_WORKFLOW_PREFIX = "dynamic workflow: ";
const SUMMARY_MAX_LENGTH = 80;
const HEADLINE_FALLBACK_LENGTH = 40;
const ELLIPSIS = "…";

export interface WorkflowSummaryOptions {
  verbose?: boolean;
}

function readField(input: unknown, key: string): string {
  if (typeof input !== "object" || input === null) return "";
  const record: Record<string, unknown> = Object(input);
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function countCharMatches(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + 1);
  }
  return count;
}

function formatExtraLines(count: number): string {
  if (count <= 0) return "";
  const unit = count === 1 ? "line" : "lines";
  return `${ELLIPSIS} +${count} ${unit}`;
}

function fallbackSummary(script: string): string {
  const headline =
    script.split("\n").find((line) => line.trim().length > 0) ??
    script.slice(0, HEADLINE_FALLBACK_LENGTH);
  const clipped =
    headline.length > SUMMARY_MAX_LENGTH
      ? `${headline.slice(0, SUMMARY_MAX_LENGTH - 1)}${ELLIPSIS}`
      : headline;
  const lineCount = countCharMatches(script, "\n") + 1;
  const extra = formatExtraLines(lineCount - 1);
  return extra ? `${clipped} ${extra}` : clipped;
}

function summarizeScript(script: string): string {
  try {
    return parseWorkflowScript(script).meta.description;
  } catch (error) {
    if (error instanceof WorkflowParseError) return fallbackSummary(script);
    throw error;
  }
}

export function workflowToolUseSummary(
  input: unknown,
  options: WorkflowSummaryOptions = {},
): string {
  const name = readField(input, "name");
  if (name.length > 0) return `${NAMED_WORKFLOW_PREFIX}${name}`;
  const script = readField(input, "script");
  if (script.length === 0) return readField(input, "scriptPath");
  if (options.verbose === true) return script;
  return summarizeScript(script);
}
