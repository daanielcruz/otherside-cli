export function userFacingToolName(name: string): string {
  if (!name) return name;
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep > 0) return rest.slice(sep + 2);
    return rest;
  }
  return name;
}
