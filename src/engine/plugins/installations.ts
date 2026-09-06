import { findPluginInstallation } from "./installation-lookups.ts";
import type { PluginInstallation } from "./installation-records.ts";
import { removePluginInstallationById } from "./installation-registry.ts";

export {
  findPluginInstallation,
  findPluginInstallationByPath,
  lookupPluginInstallation,
  pluginIdentity,
  resolvePluginInstallation,
} from "./installation-lookups.ts";
export {
  activeInstallPath,
  cachePathForPlugin,
  encodePluginPathSegment,
  pluginCacheRoot,
  projectPathFromInstallPath,
  versionedInstallPathForPlugin,
} from "./installation-paths.ts";
export type {
  InstallationId,
  PluginId,
  PluginInstallation,
  PluginInstallScope,
  PluginLookupOptions,
  PluginLookupResult,
} from "./installation-records.ts";
export {
  CURRENT_FILE_VERSION,
  formatPluginLookupFailure,
  PluginLookupError,
  PluginMigrationError,
  qualifiedPluginName,
} from "./installation-records.ts";
export {
  installedPluginsPath,
  listPluginInstallations,
  recordPluginInstallation,
  removePluginInstallationById,
  restorePluginInstallation,
} from "./installation-registry.ts";

export function forgetPluginInstallation(target: string): PluginInstallation | undefined {
  const found = findPluginInstallation(target);
  if (!found) return undefined;
  return removePluginInstallationById(found.installationId);
}
