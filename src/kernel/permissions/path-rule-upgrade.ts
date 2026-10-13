import { existsSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import { anchoredLegacyPattern, PATH_RULE_TOOLS } from "@/kernel/permissions/path-rules.ts";
import {
  atomicWriteJson,
  permissionsBlockFrom,
  readSettingsFile,
} from "@/kernel/permissions/settings-file.ts";
import {
  parseRuleValueText,
  type SettingsPermissionsBlock,
  serializeRuleValue,
} from "@/kernel/permissions/types.ts";
import { withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { configRoot, isEphemeralCwd } from "@/kernel/std/fs/paths.ts";

const UPGRADE_RECORD = "permission-path-rules.json";
const PRIVATE_FILE_MODE = 0o600;

const upgradedThisRun = new Set<string>();

/**
 * File rules this client saved before they were anchored name an absolute path with one
 * leading slash; anchored, that reads from the settings root. Each settings file this
 * client writes (the user's, and the project's local file) is rewritten once to the
 * absolute form those rules always meant. The record of rewritten files keeps a rule
 * written the anchored way afterwards from being rewritten too. True when a file changed.
 */
export async function upgradeLegacyPathRules(resolvedCwd: string | undefined): Promise<boolean> {
  const files = [configPath()];
  if (resolvedCwd && !isEphemeralCwd(resolvedCwd)) {
    files.push(join(resolvedCwd, ".otherside", "settings.local.json"));
  }
  const pending = files.filter((file) => !upgradedThisRun.has(file));
  if (pending.length === 0) return false;
  const recordPath = join(configRoot(), UPGRADE_RECORD);
  const record = readUpgradeRecord(recordPath);
  let changed = false;
  for (const file of pending) {
    upgradedThisRun.add(file);
    if (record.has(file)) continue;
    changed = (await upgradeFile(file)) || changed;
    record.add(file);
  }
  atomicWriteJson(recordPath, { files: [...record] }, PRIVATE_FILE_MODE);
  return changed;
}

async function upgradeFile(file: string): Promise<boolean> {
  if (file === configPath()) {
    const upgraded = anchoredLegacyBlock(loadConfigSync().permissions);
    if (!upgraded) return false;
    await updateConfig((cfg) => {
      cfg.permissions = upgraded;
    });
    return true;
  }
  if (!existsSync(file)) return false;
  return withFileLockSync(file, () => {
    const settings = readSettingsFile(file);
    const upgraded = anchoredLegacyBlock(permissionsBlockFrom(settings.permissions));
    if (!upgraded) return false;
    atomicWriteJson(file, { ...settings, permissions: upgraded }, PRIVATE_FILE_MODE);
    return true;
  });
}

function readUpgradeRecord(recordPath: string): Set<string> {
  const files = readSettingsFile(recordPath).files;
  return new Set(Array.isArray(files) ? files.filter((f) => typeof f === "string") : []);
}

/** The block with its legacy file rules anchored, or null when none needed it. */
function anchoredLegacyBlock(
  block: SettingsPermissionsBlock | undefined,
): SettingsPermissionsBlock | null {
  if (!block) return null;
  let changed = false;
  const anchor = (patterns: string[]): string[] =>
    patterns.map((text) => {
      const value = parseRuleValueText(text);
      if (!value?.ruleContent || !PATH_RULE_TOOLS.has(value.toolName)) return text;
      const ruleContent = anchoredLegacyPattern(value.ruleContent);
      if (ruleContent === value.ruleContent) return text;
      changed = true;
      return serializeRuleValue({ ...value, ruleContent });
    });
  const upgraded: SettingsPermissionsBlock = { ...block };
  if (block.allow) upgraded.allow = anchor(block.allow);
  if (block.ask) upgraded.ask = anchor(block.ask);
  if (block.deny) upgraded.deny = anchor(block.deny);
  return changed ? upgraded : null;
}
