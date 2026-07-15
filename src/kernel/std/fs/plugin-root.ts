// Plugins reference their own install
// directory as the literal token `${CLAUDE_PLUGIN_ROOT}` in command/args/env and
// read `CLAUDE_PLUGIN_ROOT` from the spawned environment. Shared by the plugin
// MCP loader and the plugin hook executor so both honor the same contract.
export const PLUGIN_ROOT_TOKEN = "${CLAUDE_PLUGIN_ROOT}";
export const PLUGIN_ROOT_ENV = "CLAUDE_PLUGIN_ROOT";

export function expandPluginRoot(value: string, pluginDir: string): string {
  return value.includes(PLUGIN_ROOT_TOKEN) ? value.split(PLUGIN_ROOT_TOKEN).join(pluginDir) : value;
}
