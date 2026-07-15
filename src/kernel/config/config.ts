import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { ThemeSetting } from "@/kernel/config/theme-names.ts";
import type { HookEntry, HookEvent } from "@/kernel/hooks/index.ts";
import { HOOK_EVENT_VALUES } from "@/kernel/hooks/index.ts";
import type { McpServerPolicyEntry } from "@/kernel/mcp/protocol/types.ts";
import type { SettingsPermissionsBlock } from "@/kernel/permissions/types.ts";
import { withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { atomicWriteFileSync } from "@/kernel/std/fs/secure-fs.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";

export type StatuslineConfig =
  | { type: "native"; padding?: number }
  | { type: "command"; command: string; padding?: number };

export interface UsageBucket {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  updatedAt?: string | undefined;
}

export interface UsageModelBucket extends UsageBucket {
  sessions: Record<string, UsageBucket>;
}

export interface UsageProviderBucket extends UsageBucket {
  lastModel?: string | undefined;
  models: Record<string, UsageModelBucket>;
}

export type UsageProviderMap = Partial<Record<ProviderId, UsageProviderBucket>>;

export interface ProjectEntry {
  lastSessionId?: string;
  lastUpdatedAt?: string;
  trustAccepted?: boolean;
  mcpTrustAccepted?: boolean;
  permissions?: SettingsPermissionsBlock;
  providers?: UsageProviderMap;
}

export type SettingsPermissions = SettingsPermissionsBlock;

export interface SandboxFilesystemConfig {
  denyRead?: string[];
  allowReadWithinDeny?: string[];
  allowWrite?: string[];
  denyWriteWithinAllow?: string[];
  allowGitConfig?: boolean;
}

export interface SandboxNetworkConfig {
  enabled?: boolean;
  allowAllUnixSockets?: boolean;
  allowUnixSockets?: string[];
  allowLocalBinding?: boolean;
  allowMachLookup?: string[];
}

export interface SandboxSeccompConfig {
  applyPath?: string;
  argv0?: string;
}

export interface SettingsSandboxConfig {
  enabled?: boolean;
  allowUnsandboxedCommands?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  filesystem?: SandboxFilesystemConfig;
  network?: SandboxNetworkConfig;
  allowPty?: boolean;
  failIfUnavailable?: boolean;
  enableWeakerNetworkIsolation?: boolean;
  ignoreViolations?: Record<string, string[]>;
  bwrapPath?: string;
  seccompConfig?: SandboxSeccompConfig;
  enableWeakerNestedSandbox?: boolean;
  mandatoryDenySearchDepth?: number;
}

/**
 * Session worktree settings.
 * - baseRef `fresh` (default): branch from origin/<default-branch>, HEAD fallback.
 * - baseRef `head`: branch from current HEAD.
 */
export interface WorktreeSettings {
  baseRef?: "fresh" | "head";
}

export interface GlobalState {
  numStartups?: number;
  lastStartedAt?: string;
  providers?: UsageProviderMap;
  setupHookFired?: boolean;
}

export interface UserConfig {
  defaultProvider: ProviderId;
  defaultModel: string;
  defaultMode?: PermissionMode;
  autoCompact?: boolean;
  showTips?: boolean;
  /** Injects the "# Parallel tasks" system section nudging parallel agent use. */
  parallelTasks?: boolean;
  fastMode?: boolean;
  fastModeByProvider?: Partial<Record<ProviderId, boolean>>;
  outputStyle?: string;
  statusline?: StatuslineConfig;
  language?: string;
  antigravityGoogleOneAi?: boolean;
  imageGen?: boolean;
  imageParserProvider?: ProviderId;
  imageParserModel?: string;
  memoryRecall?: boolean;
  autoMemoryEnabled?: boolean;
  ultracodeEffort?: EffortLevel;
  effortLevel?: EffortLevel;
  ultracode?: boolean;
  enableWorkflows?: boolean;
  // Per-source workflow discovery gates. Absent = enabled: on-disk workflow
  // scripts from that scope are resolvable and runnable. Set false to drop a
  // whole source without touching the master `enableWorkflows` tool gate.
  // Bundled built-ins are unaffected.
  enableUserWorkflows?: boolean;
  enableProjectWorkflows?: boolean;
  cachedExtraUsageDisabledReason?: string | null;
  disabledMcpServers?: string[];
  disabledMcpjsonServers?: string[];
  enabledMcpjsonServers?: string[];
  enableAllProjectMcpServers?: boolean;
  mcpTrustAccepted?: boolean;
  /**
   * Enterprise denylist of MCP servers, policy-scope only (managed-settings.json).
   * A server matching any entry here is never connected, regardless of which
   * scope (user/project/local/plugin) defines it. Denylist takes precedence
   * over the allowlist below. See kernel/mcp/config.ts isMcpServerDenied.
   */
  deniedMcpServers?: McpServerPolicyEntry[];
  /**
   * Enterprise allowlist of MCP servers, policy-scope only (managed-settings.json).
   * If undefined, all (non-denied) servers are allowed. If an empty array, no
   * servers are allowed. See kernel/mcp/config.ts isMcpServerAllowedByPolicy.
   */
  allowedMcpServers?: McpServerPolicyEntry[];
  /**
   * Present for upstream schema parity (policySettings.allowManagedMcpServersOnly).
   * Upstream uses this to pick which settings source(s) an allowlist may come
   * from (managed-only vs. merged across scopes). Otherside only ever sources
   * `allowedMcpServers`/`deniedMcpServers` from policy scope (see registry.ts),
   * so this flag has no additional effect here — it is recognized so managed
   * policy documents remain forward-compatible with a future non-policy allow
   * list source.
   */
  allowManagedMcpServersOnly?: boolean;
  enabledPlugins?: Record<string, boolean>;
  /**
   * Favorited plugin identities in the /plugins panel. Marketplace plugins use
   * the canonical `plugin@marketplace` ID; local plugins fall back to their name.
   */
  pluginFavorites?: string[];
  hooks?: Partial<Record<HookEvent, HookEntry[]>>;
  permissions?: SettingsPermissions;
  global?: GlobalState;
  projects?: Record<string, ProjectEntry>;
  theme?: ThemeSetting;
  sandbox?: SettingsSandboxConfig;
  /** Session EnterWorktree base-ref policy (default fresh). */
  worktree?: WorktreeSettings;
  cleanupPeriodDays?: number;
  tierSelectorEnabled?: boolean;
  orchestratorMode?: "off" | "soft";
  // Absent = enabled: tier dispatch reroutes around quota-blocked candidates.
  // false: the agent step fails explicitly instead of rerouting.
  quotaFallback?: boolean;
  terminalProgressBarEnabled?: boolean;
}

export function fastModeForProvider(cfg: UserConfig, provider: ProviderId): boolean {
  return cfg.fastModeByProvider?.[provider] ?? cfg.fastMode ?? false;
}

export function isMultiproviderOrchestrationEnabled(
  cfg: Pick<UserConfig, "orchestratorMode" | "tierSelectorEnabled"> | undefined,
): boolean {
  return (
    cfg?.orchestratorMode === "soft" ||
    (cfg?.tierSelectorEnabled === true && cfg.orchestratorMode !== "off")
  );
}

import { isProviderId, PROVIDER_ID_VALUES } from "@/kernel/config/provider-ids.ts";

export const DEFAULT_CONFIG: UserConfig = {
  defaultProvider: "anthropic",
  defaultModel: "claude-opus-4-8",
  defaultMode: "accept-edits",
  antigravityGoogleOneAi: true,
  outputStyle: "default",
  tierSelectorEnabled: false,
  orchestratorMode: "off",
};

export function configPath(): string {
  return join(configRoot(), "settings.json");
}

export async function loadConfig(): Promise<UserConfig> {
  return readConfigUnlocked().config;
}

export function loadConfigSync(): UserConfig {
  return readConfigUnlocked().config;
}

export async function saveConfig(cfg: UserConfig): Promise<void> {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  withFileLockSync(path, () => {
    writeConfigUnlocked(cfg);
  });
}

export async function updateConfig(mutator: (cfg: UserConfig) => void): Promise<UserConfig> {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(path, () => {
    const { config: cfg, corrupt } = readConfigUnlocked();
    if (corrupt) {
      throw new Error(
        `settings.json at ${path} is unreadable or corrupt. ` +
          `A backup has been saved. refusing to overwrite to avoid losing existing configuration. ` +
          `please repair or remove the file manually.`,
      );
    }
    mutator(cfg);
    writeConfigUnlocked(cfg);
    return cfg;
  });
}

export function claimInitialSetupHook(): boolean {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(path, () => {
    const hadConfigFile = existsSync(path);
    const { config: cfg, corrupt } = readConfigUnlocked();
    if (corrupt || hadConfigFile || cfg.global?.setupHookFired === true) return false;
    cfg.global = { ...cfg.global, setupHookFired: true };
    writeConfigUnlocked(cfg);
    return true;
  });
}

function readConfigUnlocked(): { config: UserConfig; corrupt: boolean } {
  const path = configPath();
  if (!existsSync(path)) {
    return { config: { ...DEFAULT_CONFIG }, corrupt: false };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<UserConfig> & {
      fast_mode?: unknown;
      statusLine?: unknown;
      statusline?: unknown;
      hooks?: unknown;
    };
    return { config: normalizeConfig(raw), corrupt: false };
  } catch (err) {
    const backup = `${path}.corrupt.${Date.now()}`;
    try {
      copyFileSync(path, backup);
    } catch {}
    process.stderr.write(
      `[otherside] settings.json is corrupt (${path}). ` +
        `backed up to ${backup}. ` +
        `write operations will be blocked until the file is repaired. ` +
        `(${err instanceof Error ? err.message : "parse error"})\n`,
    );
    return { config: { ...DEFAULT_CONFIG }, corrupt: true };
  }
}

export function normalizeConfig(
  raw: Partial<UserConfig> & {
    fast_mode?: unknown;
    statusLine?: unknown;
    statusline?: unknown;
    hooks?: unknown;
    yolo?: unknown;
    agentVerificationEnabled?: unknown;
  },
): UserConfig {
  const cfg = { ...DEFAULT_CONFIG, ...raw } as UserConfig & {
    statusLine?: unknown;
    yolo?: unknown;
    agentVerificationEnabled?: unknown;
  };
  return cfg;
}

const PERMISSION_MODES = new Set<PermissionMode>(["default", "accept-edits", "plan", "yolo"]);

export function normalizeDefaultMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "auto") return "accept-edits";
  return PERMISSION_MODES.has(value as PermissionMode) ? (value as PermissionMode) : undefined;
}

export function normalizeProviderId(value: unknown): ProviderId {
  if (typeof value !== "string") return DEFAULT_CONFIG.defaultProvider;
  const v =
    value === "anthropic-oauth"
      ? "anthropic"
      : value === "codex-oauth"
        ? "codex"
        : value === "kimi"
          ? "kimi-code"
          : value;
  return isProviderId(v) ? v : DEFAULT_CONFIG.defaultProvider;
}

export function normalizeOptionalProviderId(value: unknown): ProviderId | undefined {
  if (typeof value !== "string") return undefined;
  const v =
    value === "anthropic-oauth"
      ? "anthropic"
      : value === "codex-oauth"
        ? "codex"
        : value === "kimi"
          ? "kimi-code"
          : value;
  return isProviderId(v) ? v : undefined;
}

export function normalizeFastModeByProvider(
  value: unknown,
): Partial<Record<ProviderId, boolean>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Partial<Record<ProviderId, boolean>> = {};
  for (const provider of PROVIDER_ID_VALUES) {
    const enabled = (value as Record<string, unknown>)[provider];
    if (typeof enabled === "boolean") out[provider] = enabled;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function writeConfigUnlocked(cfg: UserConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, 0o600);
}

function statuslineTypeFrom(rawType: unknown): "command" | "native" | null {
  if (rawType === "command") return "command";
  if (rawType === "native") return "native";
  return null;
}

export function normalizeStatuslineConfig(value: unknown): StatuslineConfig | undefined {
  if (typeof value === "string") {
    const command = value.trim();
    return command ? { type: "command", command } : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const padding = normalizePadding(obj.padding);
  const type = statuslineTypeFrom(obj.type);
  const command = typeof obj.command === "string" ? obj.command.trim() : "";
  if (type === "command" || (!type && command)) {
    if (!command) return undefined;
    return padding === undefined
      ? { type: "command", command }
      : { type: "command", command, padding };
  }
  return padding === undefined ? { type: "native" } : { type: "native", padding };
}

function normalizePadding(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

const HOOK_EVENTS: ReadonlySet<string> = new Set(HOOK_EVENT_VALUES);

function normalizeHookEventKey(event: string): HookEvent | null {
  if (HOOK_EVENTS.has(event)) return event as HookEvent;
  if (event === "notification") return "Notification";
  return null;
}

export function normalizeHooksConfig(
  value: unknown,
): Partial<Record<HookEvent, HookEntry[]>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Partial<Record<HookEvent, HookEntry[]>> = {};
  for (const [event, entries] of Object.entries(value)) {
    const normalizedEvent = normalizeHookEventKey(event);
    if (normalizedEvent === null || !Array.isArray(entries)) continue;
    const normalized = entries.flatMap((entry): HookEntry[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const obj = entry as Record<string, unknown>;
      const matcher = typeof obj.matcher === "string" ? obj.matcher.trim() : "*";
      const timeoutMs =
        typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs)
          ? Math.max(1, Math.floor(obj.timeoutMs))
          : undefined;
      const type = typeof obj.type === "string" ? obj.type : undefined;
      if (type === "prompt") {
        const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
        if (!prompt) return [];
        const base: HookEntry = { type: "prompt", matcher, prompt };
        return timeoutMs === undefined ? [base] : [{ ...base, timeoutMs }];
      }
      const command = typeof obj.command === "string" ? obj.command.trim() : "";
      if (!command) return [];
      return timeoutMs === undefined ? [{ matcher, command }] : [{ matcher, command, timeoutMs }];
    });
    if (normalized.length > 0) out[normalizedEvent] = normalized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
