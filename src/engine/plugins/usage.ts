import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import { setMcpServerUseListener } from "@/kernel/mcp/client/use-listener.ts";

const DAY_MS = 86_400_000;

export function recordPluginUse(pluginId: string): void {
  const now = Date.now();
  void updateConfig((cfg) => {
    const stats = { ...cfg.pluginUsageStats };
    const previous = stats[pluginId];
    stats[pluginId] = {
      usageCount: (previous?.usageCount ?? 0) + 1,
      lastUsedAt: now,
      lastUsedNumStartups: cfg.global?.numStartups ?? 0,
    };
    cfg.pluginUsageStats = stats;
  });
}

// "Not used recently" qualification: both the day span and the session span
// since the last use must exceed their thresholds.
export const DISUSED_MIN_DAYS = 14;
export const DISUSED_MIN_SESSIONS = 10;

export interface PluginDisuse {
  daysSinceLastUse: number;
  sessionsSinceLastUse: number;
}

export function pluginDisuse(pluginId: string, now: number = Date.now()): PluginDisuse | undefined {
  const cfg = loadConfigSync();
  const stat = cfg.pluginUsageStats?.[pluginId];
  if (!stat) return undefined;
  return {
    daysSinceLastUse: Math.max(0, Math.floor((now - stat.lastUsedAt) / DAY_MS)),
    sessionsSinceLastUse: Math.max(
      0,
      (cfg.global?.numStartups ?? 0) - (stat.lastUsedNumStartups ?? 0),
    ),
  };
}

export function isPluginDisused(pluginId: string, now: number = Date.now()): boolean {
  const disuse = pluginDisuse(pluginId, now);
  return (
    disuse !== undefined &&
    disuse.daysSinceLastUse >= DISUSED_MIN_DAYS &&
    disuse.sessionsSinceLastUse >= DISUSED_MIN_SESSIONS
  );
}

export function pluginUseCount(pluginId: string): number {
  return loadConfigSync().pluginUsageStats?.[pluginId]?.usageCount ?? 0;
}

export function pluginDaysSinceUse(pluginId: string, now: number = Date.now()): number | undefined {
  const stat = loadConfigSync().pluginUsageStats?.[pluginId];
  if (!stat) return undefined;
  return Math.max(0, Math.floor((now - stat.lastUsedAt) / DAY_MS));
}

// Wires plugin MCP servers (named `plugin:{pluginId}:{server}`) into the use
// counter; registered once at corpus load.
export function registerPluginUseListener(): void {
  setMcpServerUseListener((serverName) => {
    if (!serverName.startsWith("plugin:")) return;
    const pluginId = serverName.split(":")[1];
    if (pluginId) recordPluginUse(pluginId);
  });
}
