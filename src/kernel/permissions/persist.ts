import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath, loadConfig, loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import type {
  PermissionBehavior,
  PermissionRule,
  RuleSourceScope,
  SettingsPermissionsBlock,
} from "@/kernel/permissions/types.ts";
import {
  parseRuleValueText,
  READ_ONLY_PERMISSION_SOURCES,
  serializeRuleValue,
} from "@/kernel/permissions/types.ts";
import { withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { canonicalizeCwd, configRoot, isEphemeralCwd } from "@/kernel/std/fs/paths.ts";
import { atomicWriteFileSync, mkdirSecure } from "@/kernel/std/fs/secure-fs.ts";

const PROJECT_MODE = 0o644;
const LOCAL_MODE = 0o600;
const SETTINGS_DIR_MODE = 0o755;
const GITIGNORE_ENTRY = ".otherside/settings.local.json";
const MANAGED_DROPIN_LIMIT = 50;

let rulesCache: { key: string; rules: PermissionRule[] } | null = null;

function fileMtime(filePath: string): number {
  try {
    return statSync(filePath, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  } catch {
    return 0;
  }
}

function fileSize(filePath: string): number {
  try {
    return statSync(filePath, { throwIfNoEntry: false })?.size ?? 0;
  } catch {
    return 0;
  }
}

function computeCacheKey(resolvedCwd: string | undefined): string {
  const parts: string[] = [resolvedCwd ?? ""];
  const configP = configPath();
  parts.push(`${configP}:${fileMtime(configP)}:${fileSize(configP)}`);
  if (resolvedCwd) {
    const projectP = join(resolvedCwd, ".otherside", "settings.json");
    parts.push(`${projectP}:${fileMtime(projectP)}:${fileSize(projectP)}`);
    const localP = join(resolvedCwd, ".otherside", "settings.local.json");
    parts.push(`${localP}:${fileMtime(localP)}:${fileSize(localP)}`);
  }
  const managedP = join(configRoot(), "managed-settings.json");
  parts.push(`${managedP}:${fileMtime(managedP)}:${fileSize(managedP)}`);
  const managedDropDir = join(configRoot(), "managed-settings.d");
  parts.push(`${managedDropDir}:${fileMtime(managedDropDir)}`);
  const flagPath = process.env.OTHERSIDE_FLAG_SETTINGS;
  if (flagPath) parts.push(`${flagPath}:${fileMtime(flagPath)}:${fileSize(flagPath)}`);
  return parts.join("|");
}

export function loadRulesSync(cwd?: string): PermissionRule[] {
  const resolvedCwd = cwd ? canonicalizeCwd(cwd) : undefined;
  const cacheKey = computeCacheKey(resolvedCwd);
  if (rulesCache && rulesCache.key === cacheKey) {
    return [...rulesCache.rules];
  }
  const policyRules: PermissionRule[] = [];
  appendRulesFromFile(policyRules, join(configRoot(), "managed-settings.json"), "policySettings");
  appendRulesFromFile(
    policyRules,
    join(systemPolicyDir(), "managed-settings.json"),
    "policySettings",
  );
  loadManagedDropIns(policyRules);
  loadManagedDropIns(policyRules, systemPolicyDir());
  if (isManagedPermissionRulesOnly()) {
    // Managed policy restricts loading to policy-sourced rules only: user,
    // project, local, flag, and CLI-arg rules are not consulted at all, so
    // they can neither weaken nor strengthen what the policy allows.
    rulesCache = { key: cacheKey, rules: policyRules };
    return [...policyRules];
  }
  const cfg = loadConfigSync();
  const out: PermissionRule[] = [...policyRules];
  appendRules(out, cfg.permissions, "userSettings");
  if (resolvedCwd) {
    const projectFilePath = join(resolvedCwd, ".otherside", "settings.json");
    const beforeProjectCount = out.length;
    appendRulesFromFile(out, projectFilePath, "projectSettings");
    if (out.length === beforeProjectCount) {
      const proj = cfg.projects?.[resolvedCwd];
      appendRules(out, proj?.permissions, "projectSettings");
    }
    appendRulesFromFile(
      out,
      join(resolvedCwd, ".otherside", "settings.local.json"),
      "localSettings",
    );
  }
  const flagPath = process.env.OTHERSIDE_FLAG_SETTINGS;
  if (flagPath) appendRulesFromFile(out, flagPath, "flagSettings");
  appendCliArgRules(out);
  rulesCache = { key: cacheKey, rules: out };
  return out;
}

/**
 * Returns true if any policy-sourced managed settings file (global
 * managed-settings.json, system policy dir managed-settings.json, or their
 * managed-settings.d drop-ins) sets the top-level
 * `allowManagedPermissionRulesOnly` flag to true.
 *
 * When set, only policySettings-sourced permission rules are loaded/consulted
 * and new persistent allow rules cannot be written (see saveRules).
 */
export function isManagedPermissionRulesOnly(): boolean {
  if (settingsFileHasManagedOnlyFlag(join(configRoot(), "managed-settings.json"))) return true;
  if (settingsFileHasManagedOnlyFlag(join(systemPolicyDir(), "managed-settings.json"))) {
    return true;
  }
  for (const filePath of managedDropInFilePaths(configRoot())) {
    if (settingsFileHasManagedOnlyFlag(filePath)) return true;
  }
  for (const filePath of managedDropInFilePaths(systemPolicyDir())) {
    if (settingsFileHasManagedOnlyFlag(filePath)) return true;
  }
  return false;
}

function settingsFileHasManagedOnlyFlag(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return (
      Boolean(parsed) &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).allowManagedPermissionRulesOnly === true
    );
  } catch {
    return false;
  }
}

export async function loadRules(cwd?: string): Promise<PermissionRule[]> {
  return loadRulesSync(cwd);
}

export async function loadAdditionalDirectories(cwd?: string): Promise<string[]> {
  const resolvedCwd = cwd ? canonicalizeCwd(cwd) : undefined;
  const cfg = await loadConfig();
  const out = new Set<string>();
  appendDirectories(out, cfg.permissions);
  if (resolvedCwd) {
    const projectFilePath = join(resolvedCwd, ".otherside", "settings.json");
    const beforeProjectCount = out.size;
    appendDirectoriesFromFile(out, projectFilePath);
    if (out.size === beforeProjectCount) {
      appendDirectories(out, cfg.projects?.[resolvedCwd]?.permissions);
    }
    appendDirectoriesFromFile(out, join(resolvedCwd, ".otherside", "settings.local.json"));
  }
  appendDirectoriesFromFile(out, join(configRoot(), "managed-settings.json"));
  appendDirectoriesFromFile(out, join(systemPolicyDir(), "managed-settings.json"));
  loadManagedDropInDirectories(out);
  loadManagedDropInDirectories(out, systemPolicyDir());
  const flagPath = process.env.OTHERSIDE_FLAG_SETTINGS;
  if (flagPath) appendDirectoriesFromFile(out, flagPath);
  return [...out];
}

function appendCliArgRules(out: PermissionRule[]): void {
  const allow = process.env.OTHERSIDE_CLI_ALLOWED_TOOLS;
  const deny = process.env.OTHERSIDE_CLI_DISALLOWED_TOOLS;
  appendCliArgRuleList(out, allow, "allow");
  appendCliArgRuleList(out, deny, "deny");
}

function appendCliArgRuleList(
  out: PermissionRule[],
  raw: string | undefined,
  behavior: "allow" | "deny",
): void {
  if (!raw) return;
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    const value = parseRuleValueText(trimmed);
    if (!value) continue;
    out.push({ source: "cliArg", ruleBehavior: behavior, ruleValue: value });
  }
}

export function systemPolicyDir(): string {
  if (process.env.OTHERSIDE_POLICY_DIR) return process.env.OTHERSIDE_POLICY_DIR;
  if (process.platform === "darwin") return "/Library/Application Support/Otherside";
  // Machine-wide policy lives under ProgramData (admin-writable), not Program
  // Files (binaries) — and ProgramData isn't always on the C: drive.
  if (process.platform === "win32")
    return join(process.env.PROGRAMDATA ?? "C:\\ProgramData", "Otherside");
  return "/etc/otherside";
}

function loadManagedDropIns(out: PermissionRule[], baseDir = configRoot()): void {
  for (const fullPath of managedDropInFilePaths(baseDir)) {
    appendRulesFromFile(out, fullPath, "policySettings");
  }
}

function managedDropInFilePaths(baseDir = configRoot()): string[] {
  const dropDir = join(baseDir, "managed-settings.d");
  let entries: string[];
  try {
    if (lstatSync(dropDir).isSymbolicLink()) return [];
    if (lstatSync(dropDir).isDirectory() === false) return [];
    entries = readdirSync(dropDir);
  } catch {
    return [];
  }
  const jsonFiles = entries
    .filter((name) => name.endsWith(".json") && /^[a-zA-Z0-9._-]+\.json$/.test(name))
    .sort()
    .slice(0, MANAGED_DROPIN_LIMIT);
  const out: string[] = [];
  for (const name of jsonFiles) {
    const fullPath = join(dropDir, name);
    try {
      if (lstatSync(fullPath).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    out.push(fullPath);
  }
  return out;
}

function loadManagedDropInDirectories(out: Set<string>, baseDir = configRoot()): void {
  const dropDir = join(baseDir, "managed-settings.d");
  let entries: string[];
  try {
    if (lstatSync(dropDir).isSymbolicLink()) return;
    if (lstatSync(dropDir).isDirectory() === false) return;
    entries = readdirSync(dropDir);
  } catch {
    return;
  }
  for (const name of entries
    .filter((entry) => entry.endsWith(".json") && /^[a-zA-Z0-9._-]+\.json$/.test(entry))
    .sort()
    .slice(0, MANAGED_DROPIN_LIMIT)) {
    const fullPath = join(dropDir, name);
    try {
      if (lstatSync(fullPath).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    appendDirectoriesFromFile(out, fullPath);
  }
}

/**
 * Grants the session a directory beyond the one it started in, at user scope so
 * it outlives the session the way the reader granting it expects.
 */
export async function grantWorkingDirectory(directory: string): Promise<void> {
  await updateConfig((cfg) => {
    const permissions = cfg.permissions ?? {};
    const existing = permissions.additionalDirectories ?? [];
    if (existing.includes(directory)) return;
    permissions.additionalDirectories = [...existing, directory];
    cfg.permissions = permissions;
  });
}

export async function saveRules(rules: readonly PermissionRule[], cwd?: string): Promise<void> {
  if (isManagedPermissionRulesOnly()) {
    // Policy forbids persisting new/edited rules to editable settings
    // sources while managed-only is active; policySettings rules are
    // read-only and are never written through this path anyway.
    return;
  }
  const resolvedCwd = cwd ? canonicalizeCwd(cwd) : undefined;
  await updateConfig((cfg) => {
    const additionalDirectories = cfg.permissions?.additionalDirectories;
    cfg.permissions = serializeRulesForSource(rules, "userSettings");
    if (additionalDirectories && additionalDirectories.length > 0) {
      cfg.permissions.additionalDirectories = additionalDirectories;
    }
  });
  if (resolvedCwd && !isEphemeralCwd(resolvedCwd)) {
    writeRulesForSource(
      "projectSettings",
      serializeRulesForSource(rules, "projectSettings"),
      resolvedCwd,
    );
    writeRulesForSource(
      "localSettings",
      serializeRulesForSource(rules, "localSettings"),
      resolvedCwd,
    );
  }
  rulesCache = null;
}

export async function persistAdditionalDirectoryUpdate(
  directories: readonly string[],
  source: RuleSourceScope,
  cwd: string | undefined,
  remove: boolean,
): Promise<void> {
  let existing: string[] = [];
  if (source === "userSettings") {
    existing = (await loadConfig()).permissions?.additionalDirectories ?? [];
  } else if (cwd && (source === "projectSettings" || source === "localSettings")) {
    const fileName = source === "projectSettings" ? "settings.json" : "settings.local.json";
    const settings = readSettingsFile(join(canonicalizeCwd(cwd), ".otherside", fileName));
    existing = permissionsBlockFrom(settings.permissions).additionalDirectories ?? [];
  } else {
    return;
  }
  const next = new Set(existing);
  for (const directory of directories) {
    if (remove) next.delete(directory);
    else next.add(directory);
  }
  await saveAdditionalDirectories([...next], source, cwd);
}

async function saveAdditionalDirectories(
  directories: readonly string[],
  source: RuleSourceScope,
  cwd?: string,
): Promise<void> {
  const unique = [...new Set(directories)];
  if (source === "userSettings") {
    await updateConfig((cfg) => {
      cfg.permissions = { ...cfg.permissions, additionalDirectories: unique };
    });
    return;
  }
  if (cwd && !isEphemeralCwd(cwd) && (source === "projectSettings" || source === "localSettings")) {
    writeDirectoriesForSource(source, unique, canonicalizeCwd(cwd));
  }
}

function writeDirectoriesForSource(
  source: "projectSettings" | "localSettings",
  directories: string[],
  cwd: string,
): void {
  const fileName = source === "projectSettings" ? "settings.json" : "settings.local.json";
  const mode = source === "projectSettings" ? PROJECT_MODE : LOCAL_MODE;
  const filePath = join(cwd, ".otherside", fileName);
  mkdirSecure(dirname(filePath), SETTINGS_DIR_MODE);
  withFileLockSync(filePath, () => {
    const existing = readSettingsFile(filePath);
    const permissions = permissionsBlockFrom(existing.permissions);
    if (directories.length > 0) permissions.additionalDirectories = directories;
    else delete permissions.additionalDirectories;
    if (hasPermissions(permissions)) existing.permissions = permissions;
    else delete existing.permissions;
    atomicWriteJson(filePath, existing, mode);
  });
  if (source === "localSettings" && directories.length > 0) ensureGitignoreEntry(cwd);
}

function writeRulesForSource(
  source: RuleSourceScope,
  block: SettingsPermissionsBlock,
  cwd: string,
): void {
  if (source !== "projectSettings" && source !== "localSettings") return;
  const fileName = source === "projectSettings" ? "settings.json" : "settings.local.json";
  const mode = source === "projectSettings" ? PROJECT_MODE : LOCAL_MODE;
  const filePath = join(cwd, ".otherside", fileName);
  const hasRules = Boolean(block.allow || block.ask || block.deny);
  if (!hasRules && !existsSync(filePath)) return;
  mkdirSecure(dirname(filePath), SETTINGS_DIR_MODE);
  withFileLockSync(filePath, () => {
    const existing = readSettingsFile(filePath);
    const permissions = permissionsBlockFrom(existing.permissions);
    delete permissions.allow;
    delete permissions.ask;
    delete permissions.deny;
    Object.assign(permissions, block);
    if (hasPermissions(permissions)) existing.permissions = permissions;
    else delete existing.permissions;
    atomicWriteJson(filePath, existing, mode);
  });
  if (source === "localSettings" && hasRules) {
    ensureGitignoreEntry(cwd);
  }
}

function permissionsBlockFrom(value: unknown): SettingsPermissionsBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as SettingsPermissionsBlock) };
}

function hasPermissions(block: SettingsPermissionsBlock): boolean {
  return Boolean(block.allow || block.ask || block.deny || block.additionalDirectories);
}

function readSettingsFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function atomicWriteJson(filePath: string, data: Record<string, unknown>, mode: number): void {
  mkdirSecure(dirname(filePath), mode);
  atomicWriteFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, mode);
}

function ensureGitignoreEntry(cwd: string): void {
  if (!existsSync(join(cwd, ".git"))) return;
  const gitignorePath = join(cwd, ".gitignore");
  try {
    if (lstatSync(gitignorePath).isSymbolicLink()) return;
  } catch {
    return;
  }
  withFileLockSync(gitignorePath, () => {
    let content = "";
    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, "utf8");
      if (content.includes(GITIGNORE_ENTRY)) return;
    }
    const newContent =
      content.length === 0 || content.endsWith("\n")
        ? `${content}${GITIGNORE_ENTRY}\n`
        : `${content}\n${GITIGNORE_ENTRY}\n`;
    atomicWriteFileSync(gitignorePath, newContent);
  });
}

export async function removeRule(rule: PermissionRule, cwd?: string): Promise<void> {
  if (READ_ONLY_PERMISSION_SOURCES.has(rule.source)) return;
  const existing = await loadRules(cwd);
  const key = ruleKey(rule);
  const next = existing.filter((r) => ruleKey(r) !== key);
  await saveRules(next, cwd);
}

function appendDirectories(out: Set<string>, block: SettingsPermissionsBlock | undefined): void {
  for (const directory of block?.additionalDirectories ?? []) {
    if (typeof directory === "string" && directory.length > 0) out.add(directory);
  }
}

function appendDirectoriesFromFile(out: Set<string>, filePath: string): void {
  if (!existsSync(filePath)) return;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      permissions?: SettingsPermissionsBlock;
    };
    appendDirectories(out, parsed.permissions);
  } catch {}
}

function appendRules(
  out: PermissionRule[],
  block: SettingsPermissionsBlock | undefined,
  source: RuleSourceScope,
): void {
  if (!block) return;
  pushPatterns({ out, patterns: block.allow, source, behavior: "allow" });
  pushPatterns({ out, patterns: block.ask, source, behavior: "ask" });
  pushPatterns({ out, patterns: block.deny, source, behavior: "deny" });
}

function appendRulesFromFile(
  out: PermissionRule[],
  filePath: string,
  source: RuleSourceScope,
): void {
  if (!existsSync(filePath)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return;
  }
  const block = parsed as { permissions?: SettingsPermissionsBlock } | null;
  if (block && typeof block === "object") {
    appendRules(out, block.permissions, source);
  }
}

function pushPatterns(opts: {
  out: PermissionRule[];
  patterns: string[] | undefined;
  source: RuleSourceScope;
  behavior: PermissionBehavior;
}): void {
  const { out, patterns, source, behavior } = opts;
  if (!patterns) return;
  for (const p of patterns) {
    const ruleValue = parseRuleValueText(p);
    if (!ruleValue) continue;
    out.push({ source, ruleBehavior: behavior, ruleValue });
  }
}

function serializeRulesForSource(
  rules: readonly PermissionRule[],
  source: RuleSourceScope,
): SettingsPermissionsBlock {
  const allow: string[] = [];
  const ask: string[] = [];
  const deny: string[] = [];
  for (const r of rules) {
    if (r.source !== source) continue;
    const serializedRule = serializeRuleValue(r.ruleValue);
    if (r.ruleBehavior === "allow") allow.push(serializedRule);
    else if (r.ruleBehavior === "ask") ask.push(serializedRule);
    else if (r.ruleBehavior === "deny") deny.push(serializedRule);
  }
  const block: SettingsPermissionsBlock = {};
  if (allow.length > 0) block.allow = allow;
  if (ask.length > 0) block.ask = ask;
  if (deny.length > 0) block.deny = deny;
  return block;
}

function ruleKey(rule: PermissionRule): string {
  return `${rule.source}|${rule.ruleBehavior}|${serializeRuleValue(rule.ruleValue)}`;
}
