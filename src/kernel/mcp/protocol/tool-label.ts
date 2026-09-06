import { displayMcpServerName } from "@/kernel/mcp/protocol/wire-name.ts";

/**
 * The two things a wire tool name cannot give back: the server's name before
 * `sanitizeNamePart` folded its punctuation, and the human title the server
 * declared for the tool. Recorded with the call so a transcript can still name
 * the tool after the server that served it is gone.
 */
export interface McpCallIdentity {
  server: string;
  tool: string;
}

/**
 * The only place the shown form of an MCP call is composed. Both the live label
 * and the one rebuilt from a stored identity come through here, so a change to
 * the shown form reaches history as well as the current turn.
 */
export function formatMcpToolLabel(identity: McpCallIdentity): string {
  const tool = identity.tool.replace(/\s+/g, " ").trim();
  return `${displayMcpServerName(identity.server)} - ${tool} (MCP)`;
}

/** Reads a stored identity back, rejecting anything a transcript may hold instead. */
export function readMcpCallIdentity(value: unknown): McpCallIdentity | null {
  if (!value || typeof value !== "object") return null;
  const { server, tool } = value as Record<string, unknown>;
  if (typeof server !== "string" || server.length === 0) return null;
  if (typeof tool !== "string" || tool.length === 0) return null;
  return { server, tool };
}
