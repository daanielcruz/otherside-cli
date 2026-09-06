const CLIENT_CAPABILITIES_HEADER_MAX_BYTES = 6144;

export function mcpStatelessSkipInitEnabled(): boolean {
  const val = process.env.OTHERSIDE_MCP_STATELESS_SKIP_INIT;
  if (!val) return false;
  return ["1", "true", "yes", "on"].includes(val.toLowerCase());
}

/**
 * What this client tells a server it can be asked to do.
 *
 * `elicitation` is an empty object on purpose: servers built on SDKs whose
 * elicitation type declares no fields reject a populated one, so the shape says
 * "yes" and nothing more.
 *
 * Only capabilities with a live responder belong here — a server that is told
 * yes and then never answered waits for as long as it is willing to.
 */
export function clientCapabilities(): object {
  return {
    roots: { listChanged: true },
    elicitation: {},
  };
}

export function clientCapabilitiesHeaders(): Record<string, string> {
  if (!mcpStatelessSkipInitEnabled()) return {};
  const payload = JSON.stringify(clientCapabilities());
  const encoded = Buffer.from(payload).toString("base64");
  if (Buffer.byteLength(encoded, "ascii") > CLIENT_CAPABILITIES_HEADER_MAX_BYTES) {
    return {};
  }
  return {
    "anthropic-mcp-client-capabilities": encoded,
    "MCP-Protocol-Version": "2025-03-26",
  };
}
