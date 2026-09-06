import { isEnabled, list as listPlugins } from "@/engine/plugins/registry.ts";
import { listStoredThemes, readStoredThemesFrom, type StoredTheme } from "@/kernel/theme/store.ts";

/**
 * Every palette the reader can choose: their own records, plus the ones enabled
 * plugins ship in their `themes/` directory.
 *
 * The kernel owns the file and the reader's directory; where else to look is a
 * runtime question, so composing the two belongs here rather than under it.
 *
 * A plugin record is prefixed with the plugin's name so two of them shipping
 * "Midnight" stay two palettes, and it is read-only — the editor writes to the
 * reader's directory, and a plugin's file is the plugin's.
 */
export function listAvailableThemes(): StoredTheme[] {
  const themes = [...listStoredThemes()];
  for (const entry of listPlugins()) {
    if (!isEnabled(entry.pluginId)) continue;
    const declared = [
      ...(entry.plugin.themesPath === undefined ? [] : [entry.plugin.themesPath]),
      ...(entry.plugin.themesPaths ?? []),
    ];
    for (const dir of declared) {
      themes.push(...readStoredThemesFrom(dir, "plugin", `${entry.plugin.name}:`));
    }
  }
  return themes.sort((a, b) => a.name.localeCompare(b.name));
}

/** The record a setting names, wherever it came from. */
export function findAvailableTheme(slug: string): StoredTheme | undefined {
  return listAvailableThemes().find((theme) => theme.slug === slug);
}
