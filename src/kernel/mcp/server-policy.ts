import { resolveConfig } from "@/kernel/config/resolver.ts";
import type { McpServerConfig, McpServerPolicyEntry } from "@/kernel/mcp/index.ts";

function isNamePolicyEntry(entry: McpServerPolicyEntry): entry is { serverName: string } {
  return "serverName" in entry;
}

function isCommandPolicyEntry(entry: McpServerPolicyEntry): entry is { serverCommand: string[] } {
  return "serverCommand" in entry;
}

function isUrlPolicyEntry(entry: McpServerPolicyEntry): entry is { serverUrl: string } {
  return "serverUrl" in entry;
}

// stdio servers only; returns null for remote (http/sse) servers.
function serverCommandArgv(server: McpServerConfig): string[] | null {
  return server.type === "stdio" ? [server.command, ...server.args] : null;
}

// remote (http/sse) servers only; returns null for stdio servers.
function getServerUrl(server: McpServerConfig): string | null {
  return server.type === "stdio" ? null : server.url;
}

function commandArraysMatch(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function urlPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function urlMatchesPattern(url: string, pattern: string): boolean {
  return urlPatternToRegex(pattern).test(url);
}

/**
 * True if `serverName`/`server` matches a `policySettings.deniedMcpServers`
 * entry (managed-settings.json only — see registry.ts). Checked by name,
 * and, when a server config is available, by exact stdio command array or
 * remote URL pattern.
 */
export function isMcpServerDenied(
  cwd: string,
  serverName: string,
  server?: McpServerConfig,
): boolean {
  const denied = resolveConfig(cwd).deniedMcpServers;
  if (!denied || denied.length === 0) return false;
  if (denied.some((entry) => isNamePolicyEntry(entry) && entry.serverName === serverName)) {
    return true;
  }
  if (!server) return false;
  const command = serverCommandArgv(server);
  if (
    command &&
    denied.some(
      (entry) => isCommandPolicyEntry(entry) && commandArraysMatch(entry.serverCommand, command),
    )
  ) {
    return true;
  }
  const url = getServerUrl(server);
  if (
    url &&
    denied.some((entry) => isUrlPolicyEntry(entry) && urlMatchesPattern(url, entry.serverUrl))
  ) {
    return true;
  }
  return false;
}

/**
 * True if `serverName`/`server` is allowed to connect under
 * `policySettings.deniedMcpServers`/`allowedMcpServers` (managed-settings.json
 * only — see registry.ts). Denylist takes absolute precedence. With no
 * allowlist configured, every non-denied server is allowed; an empty
 * allowlist blocks everything. When the allowlist has any command/URL-typed
 * entries, servers of that kind must match one of them (name-typed entries
 * don't fall back to name matching for a server that has a command/URL).
 */
export function isMcpServerPermittedByPolicy(
  cwd: string,
  serverName: string,
  server?: McpServerConfig,
): boolean {
  if (isMcpServerDenied(cwd, serverName, server)) return false;
  const allowed = resolveConfig(cwd).allowedMcpServers;
  if (!allowed) return true;
  if (allowed.length === 0) return false;

  const command = server ? serverCommandArgv(server) : null;
  const url = server ? getServerUrl(server) : null;

  if (command) {
    if (allowed.some(isCommandPolicyEntry)) {
      return allowed.some(
        (entry) => isCommandPolicyEntry(entry) && commandArraysMatch(entry.serverCommand, command),
      );
    }
    return allowed.some((entry) => isNamePolicyEntry(entry) && entry.serverName === serverName);
  }
  if (url) {
    if (allowed.some(isUrlPolicyEntry)) {
      return allowed.some(
        (entry) => isUrlPolicyEntry(entry) && urlMatchesPattern(url, entry.serverUrl),
      );
    }
    return allowed.some((entry) => isNamePolicyEntry(entry) && entry.serverName === serverName);
  }
  return allowed.some((entry) => isNamePolicyEntry(entry) && entry.serverName === serverName);
}
