import { get as getToolHandler } from "@/engine/tools/registry.ts";
import { formatMcpToolLabel, type McpCallIdentity } from "@/kernel/mcp/index.ts";
import { displayNameFor } from "@/ui/transcript/tool-render/args.ts";

export interface ToolLabelInput {
  name: string;
  args: unknown;
  /** Stored with the call; the only source once its server is gone. */
  mcpIdentity?: McpCallIdentity | undefined;
}

/**
 * The shown name for a tool call, in descending order of what still knows it:
 * the live handler, then the identity stored with the call, then the wire name
 * alone. The last rung is what a call recorded before identities were stored
 * has, so it stays exactly as good as it was.
 */
export function resolveToolLabel(input: ToolLabelInput): string {
  const live = getToolHandler(input.name)?.render?.userFacingLabel?.(input.args);
  if (live !== undefined) return live;
  if (input.mcpIdentity) return formatMcpToolLabel(input.mcpIdentity);
  return displayNameFor(input.name, input.args);
}
