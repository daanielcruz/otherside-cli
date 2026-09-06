import { hasProjectMcpServers, isProjectMcpTrusted } from "@/kernel/mcp/config.ts";
import type { McpConnectivityReport } from "@/kernel/mcp/runtime/manager.ts";
import { probeMcpConnectivity } from "@/kernel/mcp/runtime/manager.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";

/**
 * A refused connection is reported by the transient footer notice alone, so it
 * earns no transcript row here; only a server the user must act on to unblock
 * — one waiting for auth — is durable enough to keep.
 */
export function mcpConnectivityNotices(report: McpConnectivityReport): string[] {
  if (report.needsAuth.length === 0) return [];
  const noun = pluralize(report.needsAuth.length, "server needs", "servers need");
  return [`${report.needsAuth.length} MCP ${noun} auth · /mcp`];
}

export interface McpStartupReport {
  /** Transcript rows: the durable record of what startup found. */
  notices: string[];
  /** Servers that would not connect, reported only by the transient surface. */
  failedCount: number;
}

export async function mcpStartupNotices(cwd: string = process.cwd()): Promise<McpStartupReport> {
  const report = await probeMcpConnectivity(cwd);
  const notices = mcpConnectivityNotices(report);
  if ((await hasProjectMcpServers(cwd)) && !(await isProjectMcpTrusted(cwd))) {
    notices.push("Project MCP servers found — review and trust via /mcp");
  }
  return { notices, failedCount: report.failed.length };
}
