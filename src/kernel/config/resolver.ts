import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigSync, type UserConfig } from "@/kernel/config/config.ts";
import { SETTING_REGISTRY } from "@/kernel/config/registry.ts";
import {
  projectSettingsPath,
  readScopeRaw,
  SCOPE_PRECEDENCE,
  type SettingScope,
} from "@/kernel/config/scope.ts";
import { systemPolicyDir } from "@/kernel/permissions/persist.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";

/**
 * Resolve the effective config for a working directory by folding every scope's
 * raw settings file over the user base, per each setting's registry descriptor:
 * later scopes override (or set-union) earlier ones, and `policy` is a read-only
 * ceiling because it sits last in SCOPE_PRECEDENCE. The user base is already
 * normalized + migrated by loadConfigSync; only project/local/session/policy are
 * raw and so are validated per-key before they may override a lower scope.
 */
export function resolveConfig(cwd: string, sessionOverride?: Partial<UserConfig>): UserConfig {
  const result = { ...loadConfigSync() };

  const rawByScope: Record<Exclude<SettingScope, "user">, Record<string, unknown>> = {
    project: readScopeRaw(projectSettingsPath(cwd, "project")),
    local: readScopeRaw(projectSettingsPath(cwd, "local")),
    session: (sessionOverride ?? {}) as Record<string, unknown>,
    policy: readPolicyRaw(),
  };

  for (const scope of SCOPE_PRECEDENCE) {
    if (scope === "user") continue;
    const raw = rawByScope[scope];
    if (Object.keys(raw).length === 0) continue;

    for (const desc of SETTING_REGISTRY) {
      if (!desc.scopes.includes(scope)) continue;
      const rawVal = raw[desc.key];
      if (rawVal === undefined) continue;
      const validated = desc.validate ? desc.validate(rawVal) : rawVal;
      if (validated === undefined) continue;

      const target = result as Record<string, unknown>;
      if (desc.merge === "union" && Array.isArray(validated)) {
        const existing = (target[desc.key] as unknown[] | undefined) ?? [];
        target[desc.key] = [...new Set([...existing, ...validated])];
      } else {
        target[desc.key] = validated;
      }
    }
  }

  return result;
}

function readPolicyRaw(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // user-dir managed settings (lower precedence) then system policy (wins).
  mergeJsonFile(out, join(configRoot(), "managed-settings.json"));
  mergeDropDir(out, join(configRoot(), "managed-settings.d"));
  mergeJsonFile(out, join(systemPolicyDir(), "managed-settings.json"));
  mergeDropDir(out, join(systemPolicyDir(), "managed-settings.d"));
  return out;
}

function mergeJsonFile(target: Record<string, unknown>, path: string): void {
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      Object.assign(target, parsed);
    }
  } catch {}
}

function mergeDropDir(target: Record<string, unknown>, dir: string): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return;
  }
  for (const f of files) mergeJsonFile(target, join(dir, f));
}
