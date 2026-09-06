import type { McpToolInfo } from "@/kernel/mcp/index.ts";

export const TOOL_DESCRIPTION_MAX_CHARS = 1000;
export const PARAM_DESCRIPTION_MAX_CHARS = 200;

export function toolDisplayName(tool: McpToolInfo): string {
  if (tool.title && tool.title.trim().length > 0) return tool.title.trim();
  return tool.name;
}

export function annotationLabels(tool: McpToolInfo): string[] {
  const labels: string[] = [];
  if (tool.readOnlyHint) labels.push("read-only");
  if (tool.destructiveHint) labels.push("destructive");
  if (tool.openWorldHint) labels.push("open-world");
  return labels;
}

export function annotationText(tool: McpToolInfo): string {
  return annotationLabels(tool).join(", ");
}

/** Long text renders as a prefix plus a count of the hidden characters. */
export function clipWithCount(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… [+${text.length - maxChars} chars]`;
}

export function schemaProperties(
  schema: Record<string, unknown>,
): { name: string; type: string; description: string; required: boolean }[] {
  const rawProperties = schema.properties;
  const properties =
    rawProperties && typeof rawProperties === "object" && !Array.isArray(rawProperties)
      ? (rawProperties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((entry): entry is string => typeof entry === "string"))
    : new Set<string>();
  return Object.entries(properties).map(([name, value]) => {
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
      name,
      type: propertyType(record.type),
      description: typeof record.description === "string" ? record.description : "",
      required: required.has(name),
    };
  });
}

export function propertyType(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join(" | ");
  return "unknown";
}
