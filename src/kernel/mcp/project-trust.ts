import { resolveConfig } from "@/kernel/config/resolver.ts";
import { writeProjectSettings } from "@/kernel/config/scope.ts";
import { canonicalizeCwd } from "@/kernel/std/fs/paths.ts";
import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import { isYoloMode } from "@/kernel/std/proc/yolo-mode.ts";
import { readDisabledFromScope } from "./server-settings.ts";

export type ProjectMcpServerStatus = "approved" | "rejected" | "pending";

interface ProjectMcpTrustSettings {
  disabled: string[];
  enabled: string[];
  enableAll: boolean;
}

function normalizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function loadProjectMcpTrustSettings(cwd: string): Promise<ProjectMcpTrustSettings> {
  const cfg = resolveConfig(cwd);
  const legacyGlobalTrust = cfg.projects?.[canonicalizeCwd(cwd)]?.mcpTrustAccepted === true;
  return {
    disabled: readDisabledFromScope(cfg.disabledMcpjsonServers),
    enabled: readDisabledFromScope(cfg.enabledMcpjsonServers),
    // Migration: legacy blanket trust remains an enable-all fallback, but all new writes use
    // enableAllProjectMcpServers so existing users are not prompted again.
    enableAll:
      cfg.enableAllProjectMcpServers === true || cfg.mcpTrustAccepted === true || legacyGlobalTrust,
  };
}

function projectMcpServerStatus(
  name: string,
  settings: ProjectMcpTrustSettings,
): ProjectMcpServerStatus {
  const normalizedName = normalizeMcpName(name);
  if (settings.disabled.some((candidate) => normalizeMcpName(candidate) === normalizedName)) {
    return "rejected";
  }
  if (
    settings.enabled.some((candidate) => normalizeMcpName(candidate) === normalizedName) ||
    settings.enableAll
  ) {
    return "approved";
  }
  // Noninteractive sessions (`--print`) have no trust dialog to show. Auto-approve
  // pending project servers since project settings are always read for these
  // sessions: the operator explicitly chose print mode, and the CLI's help text
  // warns to only run it in trusted directories.
  if (getRuntimeKind() === "print") {
    return "approved";
  }
  // Yolo (--yolo/--dangerously-skip-permissions) also has no approval popup to
  // show as a bypass-permissions carve-out.
  // isYoloMode() is sourced only from the CLI flag (see yolo-mode.ts), never from
  // project settings, so a malicious .mcp.json cannot self-approve this way.
  if (isYoloMode()) {
    return "approved";
  }
  return "pending";
}

export async function loadProjectMcpServerStatuses(
  cwd: string,
  names: string[],
): Promise<Map<string, ProjectMcpServerStatus>> {
  const settings = await loadProjectMcpTrustSettings(cwd);
  return new Map(names.map((name) => [name, projectMcpServerStatus(name, settings)]));
}

export async function readProjectMcpServerStatus(
  cwd: string,
  name: string,
): Promise<ProjectMcpServerStatus> {
  const settings = await loadProjectMcpTrustSettings(cwd);
  return projectMcpServerStatus(name, settings);
}

export async function isProjectMcpTrusted(cwd: string): Promise<boolean> {
  return (await loadProjectMcpTrustSettings(cwd)).enableAll;
}

export async function setProjectMcpTrusted(cwd: string, trusted: boolean): Promise<void> {
  writeProjectSettings(cwd, "local", (file) => {
    if (trusted) file.enableAllProjectMcpServers = true;
    else delete file.enableAllProjectMcpServers;
  });
}

export async function approveProjectMcpServer(
  cwd: string,
  name: string,
  enableAll = false,
): Promise<void> {
  setProjectMcpServerDecision(cwd, name, true, enableAll);
}

export async function rejectProjectMcpServer(cwd: string, name: string): Promise<void> {
  setProjectMcpServerDecision(cwd, name, false, false);
}

function setProjectMcpServerDecision(
  cwd: string,
  name: string,
  approved: boolean,
  enableAll: boolean,
): void {
  writeProjectSettings(cwd, "local", (file) => {
    const enabled = new Set(readDisabledFromScope(file.enabledMcpjsonServers));
    const disabled = new Set(readDisabledFromScope(file.disabledMcpjsonServers));
    if (approved) {
      enabled.add(name);
      disabled.delete(name);
    } else {
      disabled.add(name);
      enabled.delete(name);
    }
    if (enabled.size === 0) delete file.enabledMcpjsonServers;
    else file.enabledMcpjsonServers = [...enabled].sort((a, b) => a.localeCompare(b));
    if (disabled.size === 0) delete file.disabledMcpjsonServers;
    else file.disabledMcpjsonServers = [...disabled].sort((a, b) => a.localeCompare(b));
    if (enableAll) file.enableAllProjectMcpServers = true;
  });
}
