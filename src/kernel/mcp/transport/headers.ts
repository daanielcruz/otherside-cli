import { resolveAuthHeader } from "@/kernel/mcp/oauth/credentials.ts";
import type { RemoteServerConfig } from "@/kernel/mcp/protocol/types.ts";
import { getClientCapabilitiesHeaders } from "./capabilities.ts";

export async function buildHeaders(options: {
  serverName: string;
  config: RemoteServerConfig;
}): Promise<Record<string, string>> {
  const { serverName, config } = options;
  const out: Record<string, string> = { ...getClientCapabilitiesHeaders() };
  if (config.headers) {
    for (const [key, value] of Object.entries(config.headers)) out[key] = value;
  }
  if (out.Authorization || out.authorization) return out;
  const credential = await resolveAuthHeader({ serverName, serverUrl: config.url });
  if (credential.kind === "header") out.Authorization = credential.value;
  return out;
}

export function hasManualAuthHeader(config: RemoteServerConfig): boolean {
  const headers = config.headers ?? {};
  return Boolean(headers.Authorization || headers.authorization);
}
