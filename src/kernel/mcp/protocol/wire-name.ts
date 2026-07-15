export const MCP_TOOL_PREFIX = "mcp__";

export function sanitizeNamePart(input: string): string {
  let out = "";
  for (const ch of input) {
    if (/^[A-Za-z0-9_-]$/.test(ch)) {
      out += ch;
    } else {
      out += "_";
    }
  }
  return out.length === 0 ? "unnamed" : out;
}

export function wireToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeNamePart(server)}__${sanitizeNamePart(tool)}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

export function parseWireToolName(name: string): [string, string] | null {
  if (!isMcpToolName(name)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const idx = rest.indexOf("__");
  if (idx < 0) return null;
  const server = rest.slice(0, idx);
  const tool = rest.slice(idx + 2);
  if (!server || !tool) return null;
  return [server, tool];
}
