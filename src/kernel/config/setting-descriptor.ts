import type { UserConfig } from "@/kernel/config/config.ts";
import type { SettingScope } from "@/kernel/config/scope.ts";

/**
 * Lock §35 contract: every setting declares the scopes it may live at and how
 * cross-scope values fold. `resolveConfig` folds raw scope files per descriptor;
 * `updateSetting` routes writes to the right scope. `validate` reuses the
 * existing config normalizers so a project/local/policy file with a garbage
 * value is skipped rather than overriding a valid lower-scope value.
 */
export interface SettingDescriptor<K extends keyof UserConfig> {
  readonly key: K;
  readonly scopes: readonly SettingScope[];
  // "map-append": a map of arrays; a later scope's entries are appended after
  // the lower scope's for the same key instead of replacing them.
  readonly merge: "override" | "union" | "map-override" | "map-append";
  readonly validate?: (value: unknown) => UserConfig[K] | undefined;
}

// -? strips UserConfig's optional modifiers so the indexed union does not leak
// `undefined` into the descriptor element type.
export type AnySettingDescriptor = {
  [K in keyof UserConfig]-?: SettingDescriptor<K>;
}[keyof UserConfig];
