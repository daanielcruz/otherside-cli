import {
  normalizeDefaultMode,
  normalizeFastModeByProvider,
  normalizeHooksConfig,
  normalizeOptionalProviderId,
  normalizeStatuslineConfig,
  type SettingsPermissions,
  type SettingsSandboxConfig,
  type UserConfig,
} from "@/kernel/config/config.ts";
import type {
  AnySettingDescriptor,
  SettingDescriptor,
} from "@/kernel/config/setting-descriptor.ts";
import type { ThemeSetting } from "@/kernel/config/theme-names.ts";
import type { McpServerPolicyEntry } from "@/kernel/mcp/protocol/types.ts";
import { EFFORT_LEVEL_VALUES } from "@/kernel/std/types/effort.ts";

function setting<K extends keyof UserConfig>(d: SettingDescriptor<K>): SettingDescriptor<K> {
  return d;
}

const isBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const isString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const isPlainObject = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v);

// A valid entry has exactly one of the three matchers, mirroring upstream's
// AllowedMcpServerEntrySchema/DeniedMcpServerEntrySchema mutual-exclusivity.
function isMcpServerPolicyEntry(v: unknown): v is McpServerPolicyEntry {
  if (!isPlainObject(v)) return false;
  const entry = v as Record<string, unknown>;
  const hasName = typeof entry.serverName === "string" && entry.serverName.length > 0;
  const hasCommand =
    Array.isArray(entry.serverCommand) &&
    entry.serverCommand.length > 0 &&
    entry.serverCommand.every((s) => typeof s === "string");
  const hasUrl = typeof entry.serverUrl === "string" && entry.serverUrl.length > 0;
  return [hasName, hasCommand, hasUrl].filter(Boolean).length === 1;
}

const isMcpServerPolicyEntryList = (v: unknown): McpServerPolicyEntry[] | undefined =>
  Array.isArray(v) ? v.filter(isMcpServerPolicyEntry) : undefined;

/**
 * Single source of truth for which scopes hold each setting and how its value
 * folds across scopes. `resolveConfig` and `updateSetting` both derive from it.
 * Adding a setting is one entry here — no parallel scope list to keep in sync.
 */
export const SETTING_REGISTRY: readonly AnySettingDescriptor[] = [
  // Scalar/object, user-only, override.
  setting({ key: "outputStyle", scopes: ["user"], merge: "override", validate: isString }),
  setting({ key: "language", scopes: ["user"], merge: "override", validate: isString }),
  setting({ key: "autoCompact", scopes: ["user"], merge: "override", validate: isBool }),
  setting({ key: "showTips", scopes: ["user"], merge: "override", validate: isBool }),
  setting({ key: "fastMode", scopes: ["user"], merge: "override", validate: isBool }),
  setting({
    key: "antigravityGoogleOneAi",
    scopes: ["user"],
    merge: "override",
    validate: isBool,
  }),
  setting({ key: "imageGen", scopes: ["user"], merge: "override", validate: isBool }),
  setting({ key: "memoryRecall", scopes: ["user"], merge: "override", validate: isBool }),
  setting({ key: "autoMemoryEnabled", scopes: ["user"], merge: "override", validate: isBool }),
  setting({ key: "ultracode", scopes: ["user"], merge: "override", validate: isBool }),
  setting({ key: "enableWorkflows", scopes: ["user"], merge: "override", validate: isBool }),
  setting({ key: "enableUserWorkflows", scopes: ["user"], merge: "override", validate: isBool }),
  setting({
    key: "enableProjectWorkflows",
    scopes: ["user"],
    merge: "override",
    validate: isBool,
  }),
  setting({ key: "tierSelectorEnabled", scopes: ["user"], merge: "override", validate: isBool }),
  setting({
    key: "cachedExtraUsageDisabledReason",
    scopes: ["user"],
    merge: "override",
    validate: (v) => (v === null || typeof v === "string" ? v : undefined),
  }),
  setting({
    key: "cleanupPeriodDays",
    scopes: ["user"],
    merge: "override",
    validate: (v) =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined,
  }),
  setting({
    key: "orchestratorMode",
    scopes: ["user"],
    merge: "override",
    validate: (v) => (v === "off" || v === "soft" ? v : undefined),
  }),
  setting({
    key: "statusline",
    scopes: ["user"],
    merge: "override",
    validate: normalizeStatuslineConfig,
  }),
  setting({
    key: "theme",
    scopes: ["user"],
    merge: "override",
    validate: (v) => (typeof v === "string" ? (v as ThemeSetting) : undefined),
  }),
  setting({
    key: "enabledPlugins",
    scopes: ["user"],
    merge: "override",
    validate: (v) => (isPlainObject(v) ? (v as Record<string, boolean>) : undefined),
  }),
  setting({
    key: "imageParserModel",
    scopes: ["user"],
    merge: "override",
    validate: (v) => (typeof v === "string" && v.length > 0 ? v : undefined),
  }),
  setting({
    key: "terminalProgressBarEnabled",
    scopes: ["user"],
    merge: "override",
    validate: isBool,
  }),

  // Internal engine state — user-only, no external scope ever supplies it.
  setting({ key: "global", scopes: ["user"], merge: "override" }),
  setting({ key: "projects", scopes: ["user"], merge: "override" }),

  // User + session (session write path deferred to owner UX ratification).
  setting({
    key: "defaultProvider",
    scopes: ["user", "session"],
    merge: "override",
    validate: normalizeOptionalProviderId,
  }),
  setting({
    key: "defaultModel",
    scopes: ["user", "session"],
    merge: "override",
    validate: (v) => (typeof v === "string" && v.length > 0 ? v : undefined),
  }),
  setting({
    key: "imageParserProvider",
    scopes: ["user", "session"],
    merge: "override",
    validate: normalizeOptionalProviderId,
  }),
  setting({
    key: "ultracodeEffort",
    scopes: ["user", "session"],
    merge: "override",
    validate: (v) =>
      typeof v === "string" && (EFFORT_LEVEL_VALUES as readonly string[]).includes(v)
        ? (v as UserConfig["ultracodeEffort"])
        : undefined,
  }),
  setting({
    key: "effortLevel",
    scopes: ["user"],
    merge: "override",
    validate: (v) =>
      typeof v === "string" && (EFFORT_LEVEL_VALUES as readonly string[]).includes(v)
        ? (v as UserConfig["effortLevel"])
        : undefined,
  }),
  setting({
    key: "fastModeByProvider",
    scopes: ["user", "session"],
    merge: "override",
    validate: normalizeFastModeByProvider,
  }),

  // User + policy ceiling (policy is last in precedence → admin wins).
  setting({
    key: "defaultMode",
    scopes: ["user", "policy"],
    merge: "override",
    validate: normalizeDefaultMode,
  }),
  setting({
    key: "sandbox",
    scopes: ["user", "policy"],
    merge: "override",
    validate: (v) => (isPlainObject(v) ? (v as SettingsSandboxConfig) : undefined),
  }),
  setting({
    key: "worktree",
    scopes: ["user", "project", "local"],
    merge: "override",
    validate: (v) => {
      if (!isPlainObject(v)) return undefined;
      const baseRef = (v as { baseRef?: unknown }).baseRef;
      if (baseRef !== undefined && baseRef !== "fresh" && baseRef !== "head") return undefined;
      return v as UserConfig["worktree"];
    },
  }),
  setting({
    key: "hooks",
    scopes: ["user", "policy"],
    merge: "override",
    validate: normalizeHooksConfig,
  }),

  // Set-union across user + project + local.
  setting({
    key: "disabledMcpServers",
    scopes: ["user", "project", "local"],
    merge: "union",
    validate: (v) =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined,
  }),
  // Project MCP trust applies every enabled persistent scope. Explicit server
  // decisions accumulate, while blanket trust follows scope precedence.
  setting({
    key: "disabledMcpjsonServers",
    scopes: ["user", "project", "local", "policy"],
    merge: "union",
    validate: (v) =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined,
  }),
  setting({
    key: "enabledMcpjsonServers",
    scopes: ["user", "project", "local", "policy"],
    merge: "union",
    validate: (v) =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined,
  }),
  setting({
    key: "enableAllProjectMcpServers",
    scopes: ["user", "project", "local", "policy"],
    merge: "override",
    validate: isBool,
  }),
  setting({
    key: "mcpTrustAccepted",
    scopes: ["user", "project", "local", "policy"],
    merge: "override",
    validate: isBool,
  }),
  // Enterprise MCP server allow/deny-list, policy-scope only: sourced solely
  // from managed-settings.json (see resolver.ts readPolicyRaw), never from
  // user/project/local settings.json, so a repo's own .mcp.json cannot grant
  // itself an exemption. Consulted in kernel/mcp/config.ts before a server is
  // ever added to the enabled/connectable config.
  setting({
    key: "deniedMcpServers",
    scopes: ["policy"],
    merge: "override",
    validate: isMcpServerPolicyEntryList,
  }),
  setting({
    key: "allowedMcpServers",
    scopes: ["policy"],
    merge: "override",
    validate: isMcpServerPolicyEntryList,
  }),
  setting({
    key: "allowManagedMcpServersOnly",
    scopes: ["policy"],
    merge: "override",
    validate: isBool,
  }),

  // Permissions block is carried coarsely; persist.ts does the rule-level merge.
  setting({
    key: "permissions",
    scopes: ["user", "project", "local", "policy"],
    merge: "override",
    validate: (v) => (isPlainObject(v) ? (v as SettingsPermissions) : undefined),
  }),
];

export function descriptorFor(key: keyof UserConfig): AnySettingDescriptor | undefined {
  return SETTING_REGISTRY.find((d) => d.key === key);
}
