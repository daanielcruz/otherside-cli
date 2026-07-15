import { type UserConfig, updateConfig } from "@/kernel/config/config.ts";
import { descriptorFor } from "@/kernel/config/registry.ts";
import type { SettingScope } from "@/kernel/config/scope.ts";
import { writeProjectSettings } from "@/kernel/config/scope.ts";

type WritableScope = "user" | "project" | "local";

function firstWritableScope(scopes: readonly SettingScope[]): WritableScope {
  const scope = scopes.find((s) => s !== "session" && s !== "policy");
  return (scope ?? "user") as WritableScope;
}

/**
 * Write a single setting to the scope declared (or chosen) for it, validating
 * the value against the registry first. User-scope writes go through the locked
 * updateConfig primitive; project/local writes go to the cwd's settings files.
 * Merge-style keys (object/array unions) keep using updateConfig directly — this
 * router replaces a whole scalar/object value, not an in-place atomic merge.
 */
export async function updateSetting<K extends keyof UserConfig>(
  key: K,
  value: UserConfig[K],
  opts: { scope?: WritableScope; cwd?: string } = {},
): Promise<void> {
  const desc = descriptorFor(key);
  if (!desc) throw new Error(`updateSetting: unknown key "${String(key)}"`);

  const validated = desc.validate ? desc.validate(value) : value;
  if (validated === undefined) throw new Error(`updateSetting: invalid value for "${String(key)}"`);

  const scope = opts.scope ?? firstWritableScope(desc.scopes);
  if (!desc.scopes.includes(scope)) {
    throw new Error(`updateSetting: "${String(key)}" cannot be written at ${scope} scope`);
  }

  if (scope === "user") {
    await updateConfig((cfg) => {
      (cfg as unknown as Record<string, unknown>)[key as string] = validated;
    });
    return;
  }

  if (!opts.cwd) {
    throw new Error(`updateSetting: cwd required for ${scope}-scope write of "${String(key)}"`);
  }
  writeProjectSettings(opts.cwd, scope, (file) => {
    (file as Record<string, unknown>)[key as string] = validated;
  });
}
