import type { McpServerConfig, McpServerSpec } from "@/kernel/mcp/index.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";

export function parseServer(name: string, raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object") {
    process.stderr.write(`mcp: server "${name}" entry is not an object — skipped\n`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const kind = typeof obj.type === "string" ? obj.type.toLowerCase() : null;
  const hasCommand = typeof obj.command === "string";
  const hasUrl = typeof obj.url === "string";
  if (kind === "stdio" || (kind === null && hasCommand)) {
    const command = typeof obj.command === "string" ? obj.command : "";
    if (!command) {
      process.stderr.write(`mcp: server "${name}" stdio entry missing command — skipped\n`);
      return null;
    }
    const args =
      Array.isArray(obj.args) && obj.args.every((v) => typeof v === "string")
        ? (obj.args as string[])
        : [];
    const envRaw = obj.env;
    let env: Record<string, string> | undefined;
    if (envRaw && typeof envRaw === "object" && !Array.isArray(envRaw)) {
      const acc: Record<string, string> = {};
      for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
        if (typeof v === "string") acc[k] = v;
      }
      env = acc;
    }
    const cwd = typeof obj.cwd === "string" && obj.cwd.length > 0 ? obj.cwd : undefined;
    return {
      type: "stdio",
      command,
      args,
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }
  if (kind === "http" || kind === "sse" || (kind === null && hasUrl)) {
    const transport: "http" | "sse" = kind === "sse" ? "sse" : "http";
    const url = typeof obj.url === "string" ? obj.url : "";
    if (!url) {
      process.stderr.write(`mcp: server "${name}" ${transport} entry missing url — skipped\n`);
      return null;
    }
    const headers = parseHeaders(obj.headers);
    const oauth =
      obj.oauth && typeof obj.oauth === "object" && !Array.isArray(obj.oauth)
        ? (obj.oauth as Record<string, unknown>)
        : null;
    const oauthScopes = oauth && typeof oauth.scope === "string" ? oauth.scope : undefined;
    return {
      type: transport,
      url,
      ...(headers ? { headers } : {}),
      ...(oauthScopes ? { oauthScopes } : {}),
    };
  }
  process.stderr.write(`mcp: server "${name}" unsupported transport "${obj.type}" — skipped\n`);
  return null;
}

export function parseMcpServerSpec(raw: string): McpServerSpec | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("{")) return trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const entry = Object.entries(parsed)[0];
  if (!entry || Object.keys(parsed).length !== 1) return null;
  const [name, rawConfig] = entry;
  const config = parseServer(name, rawConfig);
  return config ? { [name]: config } : null;
}

function parseHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function expandEnvironmentValue(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, expression: string) => {
    const separator = expression.indexOf(":-");
    const name = separator === -1 ? expression : expression.slice(0, separator);
    const fallback = separator === -1 ? undefined : expression.slice(separator + 2);
    return process.env[name] ?? fallback ?? match;
  });
}

export function expandServerEnvironment(server: McpServerConfig): McpServerConfig {
  if (server.type === "stdio") {
    return {
      ...server,
      command: expandEnvironmentValue(server.command),
      args: server.args.map(expandEnvironmentValue),
      ...(server.cwd ? { cwd: expandEnvironmentValue(server.cwd) } : {}),
      ...(server.env
        ? {
            env: Object.fromEntries(
              Object.entries(server.env).map(([k, v]) => [k, expandEnvironmentValue(v)]),
            ),
          }
        : {}),
    };
  }
  return {
    ...server,
    url: expandEnvironmentValue(server.url),
    ...(server.headers
      ? {
          headers: Object.fromEntries(
            Object.entries(server.headers).map(([k, v]) => [k, expandEnvironmentValue(v)]),
          ),
        }
      : {}),
  };
}
