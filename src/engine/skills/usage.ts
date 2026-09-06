import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";

const DAY_MS = 86_400_000;

export interface SkillUse {
  count: number;
  daysSinceUse: number;
}

export function skillUseFor(name: string, now: number = Date.now()): SkillUse | undefined {
  const stat = loadConfigSync().skillUsageStats?.[name];
  if (!stat) return undefined;
  return {
    count: stat.usageCount,
    daysSinceUse: Math.max(0, Math.floor((now - stat.lastUsedAt) / DAY_MS)),
  };
}

export function recordSkillUse(name: string): void {
  const now = Date.now();
  void updateConfig((cfg) => {
    const stats = { ...cfg.skillUsageStats };
    const previous = stats[name];
    stats[name] = { usageCount: (previous?.usageCount ?? 0) + 1, lastUsedAt: now };
    cfg.skillUsageStats = stats;
  });
}
