import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_ORCHESTRATION_MODE,
  normalizeOrchestrationMode,
  type OrchestrationMode,
} from "@/kernel/config/orchestration-mode.ts";
import type {
  ImageGeneratorSelection,
  ProviderId,
  VoiceProviderSelection,
} from "@/kernel/config/provider-ids.ts";
import type { ThemeSetting } from "@/kernel/config/theme-names.ts";
import type { HookEntry, HookEvent } from "@/kernel/hooks/index.ts";
import { HOOK_EVENT_VALUES } from "@/kernel/hooks/index.ts";
import type { McpServerPolicyEntry } from "@/kernel/mcp/protocol/types.ts";
import type { SettingsPermissionsBlock } from "@/kernel/permissions/types.ts";
import { withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { canonicalizeCwd, configRoot } from "@/kernel/std/fs/paths.ts";
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

/**
 * Persisted worktree session slot for a project (single slot per project,
 * keyed by the repository root). Written when a session enters a worktree,
 * cleared when it exits; resume restores the active worktree from here.
 */
export interface ActiveWorktreeSessionEntry {
  sessionId: string;
  originalCwd: string;
  preEnterOriginalCwd?: string;
  activePath: string;
  worktreeName?: string;
  managedBranch?: string;
  baseSha?: string;
  ownerRepoRoot?: string;
  nestedRepoRoot?: string;
  hookBased?: boolean;
  lockReason?: string;
  resumedExisting?: boolean;
  resetToFreshBase?: boolean;
  ownership: "created" | "enteredExisting";
  tmuxSession?: string;
}

export interface ProjectEntry {
  lastSessionId?: string;
  lastUpdatedAt?: string;
  trustAccepted?: boolean;
  mcpTrustAccepted?: boolean;
  permissions?: SettingsPermissionsBlock;
  providers?: UsageProviderMap;
  activeWorktreeSession?: ActiveWorktreeSessionEntry;
}

/**
 * Canonical `projects`-map key for a directory. Case folds on Windows only —
 * its path APIs freely flip drive/segment casing — so writers and readers of
 * per-project entries (worktree slot, trust) agree on one key.
 */
export function projectConfigKey(dir: string): string {
  const key = canonicalizeCwd(resolve(dir)).normalize("NFC");
  return process.platform === "win32" ? key.toLowerCase() : key;
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
 * - sparsePaths: cone-mode sparse-checkout paths applied to created worktrees.
 * - symlinkDirectories: repo-relative directories symlinked from the main
 *   checkout into created worktrees instead of being materialized.
 */
export interface WorktreeSettings {
  baseRef?: "fresh" | "head";
  sparsePaths?: string[];
  symlinkDirectories?: string[];
}

export interface GlobalState {
  numStartups?: number;
  lastStartedAt?: string;
  providers?: UsageProviderMap;
  setupHookFired?: boolean;
  /** Times the queued-edit prompt hint has been shown; it retires after three. */
  queuedEditHintShowCount?: number;
}

export const WORKFLOW_SIZE_GUIDELINES = ["unrestricted", "small", "medium", "large"] as const;

export type WorkflowSizeGuideline = (typeof WORKFLOW_SIZE_GUIDELINES)[number];

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
  imageGenProvider?: ImageGeneratorSelection;
  voiceProvider?: VoiceProviderSelection;
  imageParserProvider?: ProviderId;
  imageParserModel?: string;
  memoryRecall?: boolean;
  autoMemoryEnabled?: boolean;
  ultracodeEffort?: EffortLevel;
  effortLevel?: EffortLevel;
  ultracode?: boolean;
  enableWorkflows?: boolean;
  workflowSizeGuideline?: WorkflowSizeGuideline;
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
   * Flag indicating whether to allow managed MCP servers only.
   * Otherside only ever sources `allowedMcpServers`/`deniedMcpServers` from
   * policy scope (see registry.ts), so this flag has no additional effect here —
   * it is recognized so managed policy documents remain forward-compatible with
   * a future non-policy allow list source.
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
  orchestrationMode?: OrchestrationMode;
  // Absent = enabled: tier dispatch reroutes around quota-blocked candidates.
  // false: the agent step fails explicitly instead of rerouting.
  quotaFallback?: boolean;
  // Absent = enabled: a nested agent cannot launch above its own tier (its
  // requests clamp to the caller's tier). false lifts the ceiling.
  chainOfCommand?: boolean;
  terminalProgressBarEnabled?: boolean;
}

export function fastModeForProvider(cfg: UserConfig, provider: ProviderId): boolean {
  return cfg.fastModeByProvider?.[provider] ?? cfg.fastMode ?? false;
}

export function effectiveOrchestrationMode(
  cfg: Pick<UserConfig, "orchestrationMode"> | undefined,
): OrchestrationMode {
  return normalizeOrchestrationMode(cfg?.orchestrationMode);
}

import {
  isImageGeneratorSelection,
  isProviderId,
  isVoiceProviderSelection,
  PROVIDER_ID_VALUES,
} from "@/kernel/config/provider-ids.ts";

export const DEFAULT_CONFIG: UserConfig = {
  defaultProvider: "anthropic",
  defaultModel: "claude-opus-4-8",
  defaultMode: "accept-edits",
  antigravityGoogleOneAi: true,
  outputStyle: "default",
  orchestrationMode: DEFAULT_ORCHESTRATION_MODE,
  workflowSizeGuideline: "unrestricted",
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

export function normalizeEnabledPlugins(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, boolean> = {};
  for (const [pluginId, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean") result[pluginId] = enabled;
  }
  return result;
}

export function normalizeConfig(
  raw: Partial<UserConfig> & {
    fast_mode?: unknown;
    statusLine?: unknown;
    statusline?: unknown;
    hooks?: unknown;
    yolo?: unknown;
    agentVerificationEnabled?: unknown;
    enabledPlugins?: unknown;
    imageGen?: unknown;
    imageGenProvider?: unknown;
    voiceProvider?: unknown;
    tierSelectorEnabled?: unknown;
    orchestratorMode?: unknown;
    orchestrationMode?: unknown;
  },
): UserConfig {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...raw,
    workflowSizeGuideline: normalizeWorkflowSizeGuideline(raw.workflowSizeGuideline),
  } as UserConfig & {
    statusLine?: unknown;
    yolo?: unknown;
    agentVerificationEnabled?: unknown;
    enabledPlugins?: unknown;
    imageGen?: unknown;
    imageGenProvider?: unknown;
    voiceProvider?: unknown;
    tierSelectorEnabled?: unknown;
    orchestratorMode?: unknown;
    orchestrationMode?: unknown;
  };
  cfg.orchestrationMode = normalizeOrchestrationMode(raw.orchestrationMode);
  delete (cfg as unknown as Record<string, unknown>).dictationLanguage;
  delete cfg.tierSelectorEnabled;
  delete cfg.orchestratorMode;
  const enabledPlugins = normalizeEnabledPlugins(cfg.enabledPlugins);
  if (enabledPlugins === undefined) delete cfg.enabledPlugins;
  else cfg.enabledPlugins = enabledPlugins;
  const imageGenProvider = cfg.imageGenProvider;
  if (isImageGeneratorSelection(imageGenProvider)) {
    cfg.imageGenProvider = imageGenProvider;
  } else if (cfg.imageGen === true) {
    cfg.imageGenProvider = "codex";
  } else {
    delete cfg.imageGenProvider;
  }
  delete cfg.imageGen;
  if (!isVoiceProviderSelection(cfg.voiceProvider)) delete cfg.voiceProvider;
  return cfg as UserConfig;
}

const PERMISSION_MODES = new Set<PermissionMode>(["default", "accept-edits", "plan", "yolo"]);

export function normalizeWorkflowSizeGuideline(value: unknown): WorkflowSizeGuideline {
  return typeof value === "string" &&
    (WORKFLOW_SIZE_GUIDELINES as readonly string[]).includes(value)
    ? (value as WorkflowSizeGuideline)
    : "unrestricted";
}

export function normalizeDefaultMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "auto") return "accept-edits";
  return PERMISSION_MODES.has(value as PermissionMode) ? (value as PermissionMode) : undefined;
}

export function normalizeProviderId(value: unknown): ProviderId {
  return isProviderId(value) ? value : DEFAULT_CONFIG.defaultProvider;
}

export function normalizeOptionalProviderId(value: unknown): ProviderId | undefined {
  return isProviderId(value) ? value : undefined;
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
      const base: HookEntry = {
        matcher,
        command,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        // Async Stop-hook flags (stop-hook-rewake.ts): passed through verbatim.
        ...(obj.async === true ? { async: true } : {}),
        ...(obj.asyncRewake === true ? { asyncRewake: true } : {}),
        ...(typeof obj.rewakeMessage === "string" && obj.rewakeMessage.trim().length > 0
          ? { rewakeMessage: obj.rewakeMessage }
          : {}),
        ...(typeof obj.rewakeSummary === "string" && obj.rewakeSummary.trim().length > 0
          ? { rewakeSummary: obj.rewakeSummary }
          : {}),
      };
      return [base];
    });
    if (normalized.length > 0) out[normalizedEvent] = normalized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
