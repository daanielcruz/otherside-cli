const CLIENT_CAPABILITIES_HEADER_MAX_BYTES = 6144;

export function isMcpStatelessSkipInitEnabled(): boolean {
  const val = process.env.OTHERSIDE_MCP_STATELESS_SKIP_INIT;
  if (!val) return false;
  return ["1", "true", "yes", "on"].includes(val.toLowerCase());
}

function getClientCapabilities(): object {
  return {
    roots: {},
    elicitation: {},
  };
}

export function getClientCapabilitiesHeaders(): Record<string, string> {
  if (!isMcpStatelessSkipInitEnabled()) return {};
  const payload = JSON.stringify(getClientCapabilities());
  const encoded = Buffer.from(payload).toString("base64");
  if (Buffer.byteLength(encoded, "ascii") > CLIENT_CAPABILITIES_HEADER_MAX_BYTES) {
    return {};
  }
  return {
    "anthropic-mcp-client-capabilities": encoded,
    "MCP-Protocol-Version": "2025-03-26",
  };
}
