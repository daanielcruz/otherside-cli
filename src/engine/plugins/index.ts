export type { PluginInstallation, PluginInstallScope } from "./installations.ts";
export {
  activeInstallPath,
  findPluginInstallation,
  listPluginInstallations,
  qualifiedPluginName,
} from "./installations.ts";
export type {
  LoadedPlugin,
  PluginLoadError,
  PluginLoadResult,
  ResolvedPlugin,
} from "./loader.ts";
export {
  loadPluginFromDirectory,
  loadPluginsFromDirectories,
  resolvePluginComponents,
} from "./loader.ts";
export type { CommandMetadata, PluginManifest } from "./manifest.ts";
export { parseManifest } from "./manifest.ts";

export {
  clear,
  get,
  isEnabled,
  isRuntimeEnabled,
  list,
  register,
  setEnabled,
  unregister,
} from "./registry.ts";
