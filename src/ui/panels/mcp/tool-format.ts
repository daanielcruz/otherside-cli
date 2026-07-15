import type { McpToolInfo } from "@/kernel/mcp/index.ts";
import { capitalize } from "@/kernel/std/text/text.ts";

const BROWSER_TOOL_LABELS: Record<string, string> = {
  browser_click: "Click",
  browser_close: "Close browser",
  browser_console_messages: "Get console messages",
  browser_drag: "Drag mouse",
  browser_evaluate: "Evaluate JavaScript",
  browser_file_upload: "Upload files",
  browser_fill_form: "Fill form",
  browser_handle_dialog: "Handle a dialog",
  browser_hover: "Hover mouse",
  browser_navigate: "Navigate to a URL",
  browser_navigate_back: "Go back",
  browser_network_requests: "List network requests",
  browser_press_key: "Press a key",
  browser_resize: "Resize browser window",
  browser_run_code: "Run Playwright code",
  browser_select_option: "Select option",
  browser_snapshot: "Page snapshot",
  browser_tabs: "Manage tabs",
  browser_take_screenshot: "Take a screenshot",
  browser_type: "Type text",
  browser_wait_for: "Wait for",
};

export function toolDisplayName(tool: McpToolInfo): string {
  if (tool.title && tool.title.trim().length > 0) return tool.title.trim();
  const browserLabel = BROWSER_TOOL_LABELS[tool.name];
  if (browserLabel) return browserLabel;
  const withoutBrowser = tool.name.startsWith("browser_")
    ? tool.name.slice("browser_".length)
    : tool.name;
  return withoutBrowser
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part, index) => (index === 0 ? capitalize(part) : part))
    .join(" ");
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

export function schemaProperties(
  schema: Record<string, unknown>,
): { name: string; type: string; description: string; required: boolean }[] {
  const rawProperties = schema.properties;
  const properties =
    rawProperties && typeof rawProperties === "object" && !Array.isArray(rawProperties)
      ? (rawProperties as Record<string, unknown>)
      : {};
  const requiredRaw = schema.required;
  const required = Array.isArray(requiredRaw)
    ? new Set(requiredRaw.filter((value): value is string => typeof value === "string"))
    : new Set<string>();
  return Object.entries(properties).map(([name, value]) => {
    const property = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
      name,
      type: propertyType(property.type),
      description: typeof property.description === "string" ? property.description : "",
      required: required.has(name),
    };
  });
}

export function propertyType(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join(" | ");
  return "unknown";
}
