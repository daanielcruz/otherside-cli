import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";

/**
 * The plugins the user pinned to the top of the installed list. Stored by canonical
 * plugin identity so a favourite survives a reinstall from the same marketplace.
 */
export function loadFavoriteNames(): ReadonlySet<string> {
  const favorites = loadConfigSync().pluginFavorites;
  if (!Array.isArray(favorites)) return new Set();
  return new Set(
    favorites.filter((name): name is string => typeof name === "string" && name.length > 0),
  );
}

export function persistFavorites(next: ReadonlySet<string>): void {
  void updateConfig((cfg) => {
    cfg.pluginFavorites = [...next].sort((a, b) => a.localeCompare(b));
  });
}
