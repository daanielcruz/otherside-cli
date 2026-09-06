import { loadConfig } from "@/kernel/config/config.ts";
import { readProjectSettings, writeProjectSettings } from "@/kernel/config/scope.ts";

export function readDisabledFromScope(values: unknown): string[] {
  return (Array.isArray(values) ? values : []).filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
}

export async function loadDisabledMcpServers(cwd: string): Promise<Set<string>> {
  const local = readProjectSettings(cwd, "local");
  const project = readProjectSettings(cwd, "project");
  const cfg = await loadConfig();
  const merged = new Set<string>([
    ...readDisabledFromScope(cfg.disabledMcpServers),
    ...readDisabledFromScope(project.disabledMcpServers),
    ...readDisabledFromScope(local.disabledMcpServers),
  ]);
  return merged;
}

export async function disableMcpServer(cwd: string, name: string): Promise<void> {
  setMcpDisabledFlag(cwd, name, true);
}

export async function enableMcpServer(cwd: string, name: string): Promise<void> {
  setMcpDisabledFlag(cwd, name, false);
}

function setMcpDisabledFlag(cwd: string, name: string, disabled: boolean): void {
  writeProjectSettings(cwd, "local", (file) => {
    const current = new Set(readDisabledFromScope(file.disabledMcpServers));
    if (disabled) current.add(name);
    else current.delete(name);
    if (current.size === 0) delete file.disabledMcpServers;
    else file.disabledMcpServers = [...current].sort((a, b) => a.localeCompare(b));
  });
}
