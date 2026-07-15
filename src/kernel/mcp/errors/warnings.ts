import { hasProjectMcpServers, isProjectMcpTrusted } from "@/kernel/mcp/config.ts";
import type { McpConnectivityReport } from "@/kernel/mcp/runtime/manager.ts";
import { probeMcpConnectivity } from "@/kernel/mcp/runtime/manager.ts";
import { publish } from "@/kernel/std/notifications.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";

export function publishConnectivityWarnings(report: McpConnectivityReport): void {
  if (report.failed.length > 0) {
    const noun = pluralize(report.failed.length, "server", "servers");
    publish("error", `${report.failed.length} MCP ${noun} failed · /mcp`);
  }
  if (report.needsAuth.length > 0) {
    const noun = pluralize(report.needsAuth.length, "server needs", "servers need");
    publish("error", `${report.needsAuth.length} MCP ${noun} auth · /mcp`);
  }
}

export async function warnOnMcpFailures(
  cwd: string = process.cwd(),
): Promise<McpConnectivityReport> {
  const report = await probeMcpConnectivity(cwd);
  publishConnectivityWarnings(report);
  if ((await hasProjectMcpServers(cwd)) && !(await isProjectMcpTrusted(cwd))) {
    publish("error", "Project MCP servers found — review and trust via /mcp");
  }
  return report;
}
