import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { SettingsPermissionsBlock } from "@/kernel/permissions/types.ts";
import { withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { chmodIfPosix } from "@/kernel/std/fs/secure-fs.ts";

// SoT: scope precedence IS the scope enumeration; SettingScope derives from it.
export const SCOPE_PRECEDENCE = ["user", "project", "local", "session", "policy"] as const;

export type SettingScope = (typeof SCOPE_PRECEDENCE)[number];

export interface ProjectSettingsFile {
  enabledPlugins?: Record<string, boolean>;
  disabledMcpServers?: string[];
  disabledMcpjsonServers?: string[];
  enabledMcpjsonServers?: string[];
  enableAllProjectMcpServers?: boolean;
  mcpTrustAccepted?: boolean;
  permissions?: SettingsPermissionsBlock;
  /**
   * MCP servers configured in the current project's local (untracked) scope —
   * i.e. personal to this checkout, not shared via .mcp.json. Raw/unvalidated;
   * parsed by kernel/mcp/config.ts. Granted the highest
   * manual-scope precedence and is exempt from project trust prompting.
   */
  mcpServers?: Record<string, unknown>;
}

const PROJECT_SETTINGS_DIR = ".otherside";
const PROJECT_SETTINGS_NAME = "settings.json";
const LOCAL_SETTINGS_NAME = "settings.local.json";

export function projectSettingsPath(cwd: string, kind: "local" | "project"): string {
  const name = kind === "local" ? LOCAL_SETTINGS_NAME : PROJECT_SETTINGS_NAME;
  return join(cwd, PROJECT_SETTINGS_DIR, name);
}

export function userSettingsPath(): string {
  return join(configRoot(), "settings.json");
}

function readJsonOrEmpty(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readProjectSettings(cwd: string, kind: "local" | "project"): ProjectSettingsFile {
  return readJsonOrEmpty(projectSettingsPath(cwd, kind)) as ProjectSettingsFile;
}

export function readScopeRaw(path: string): Record<string, unknown> {
  return readJsonOrEmpty(path);
}

export function writeProjectSettings(
  cwd: string,
  kind: "local" | "project",
  mutator: (file: ProjectSettingsFile) => void,
): void {
  const path = projectSettingsPath(cwd, kind);
  mkdirSync(dirname(path), { recursive: true });
  withFileLockSync(path, () => {
    const current = readJsonOrEmpty(path) as ProjectSettingsFile;
    mutator(current);
    atomicWriteProjectSettings(path, `${JSON.stringify(current, null, 2)}\n`);
  });
  ensureLocalGitignore(cwd, kind);
}

function atomicWriteProjectSettings(path: string, data: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    chmodIfPosix(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
}

function ensureLocalGitignore(cwd: string, kind: "local" | "project"): void {
  if (kind !== "local") return;
  const gitignorePath = join(cwd, PROJECT_SETTINGS_DIR, ".gitignore");
  const entry = LOCAL_SETTINGS_NAME;
  let content = "";
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, "utf8");
    const lines = content.split(/\r?\n/);
    if (lines.some((l) => l.trim() === entry)) return;
  }
  const next =
    content.length === 0 || content.endsWith("\n")
      ? `${content}${entry}\n`
      : `${content}\n${entry}\n`;
  writeFileSync(gitignorePath, next);
}

export type { SettingDescriptor } from "@/kernel/config/setting-descriptor.ts";
