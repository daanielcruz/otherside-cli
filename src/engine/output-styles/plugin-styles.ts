import { isEnabled, list as listPlugins } from "@/engine/plugins/registry.ts";
import type { OutputStyleRecord } from "@/harness/routines/output-styles/built-in.ts";

/**
 * Styles a plugin ships in its `output-styles/` directory.
 *
 * Names are prefixed with the plugin, the way its commands and agents are, so
 * two plugins shipping "Concise" stay two styles and the roster says which one
 * each came from. Only enabled plugins contribute: a disabled plugin is one the
 * reader turned off, and a style is as much a contribution as a command.
 */
export function pluginOutputStyleDirs(): { plugin: string; dir: string }[] {
  const dirs: { plugin: string; dir: string }[] = [];
  for (const entry of listPlugins()) {
    if (!isEnabled(entry.pluginId)) continue;
    const declared = [
      ...(entry.plugin.outputStylesPath === undefined ? [] : [entry.plugin.outputStylesPath]),
      ...(entry.plugin.outputStylesPaths ?? []),
    ];
    for (const dir of declared) dirs.push({ plugin: entry.plugin.name, dir });
  }
  return dirs;
}

export function pluginStyleName(plugin: string, style: string): string {
  return `${plugin}:${style}`;
}

/**
 * The style a plugin insists on, which stands in for whatever the reader chose.
 *
 * A plugin ships this when its prompt only works under a voice it controls. Two
 * plugins can both insist; the first wins, because there is no ordering between
 * them that means anything to the reader.
 */
export function forcedPluginStyle(
  styles: Iterable<OutputStyleRecord>,
): OutputStyleRecord | undefined {
  for (const style of styles) {
    if (style.source === "plugin" && style.forceForPlugin === true) return style;
  }
  return undefined;
}
