import {
  type CustomThemeId,
  isCustomThemeId,
  slugFromCustomThemeId,
} from "@/kernel/config/theme-names.ts";
import type { StoredTheme } from "@/kernel/theme/store.ts";
import { findAvailableTheme } from "@/ui/theme/custom/catalog.ts";
import { applyThemeOverrides } from "@/ui/theme/custom/resolve.ts";
import { resolveThemeSetting } from "@/ui/theme/system-theme.ts";
import {
  getThemeRecord,
  setActiveCustomTheme,
  setActiveTheme,
  type ThemeSetting,
} from "@/ui/theme/theme.ts";

/**
 * Puts a setting in force, whatever kind it names. A stored theme that has gone
 * missing or unreadable falls back to the shipped dark palette rather than
 * leaving the previous one on screen, so the setting and the colours never
 * disagree.
 */
export function applyThemeSetting(setting: ThemeSetting): void {
  if (!isCustomThemeId(setting)) {
    setActiveTheme(resolveThemeSetting(setting));
    return;
  }
  const stored = findAvailableTheme(slugFromCustomThemeId(setting));
  if (!stored) {
    setActiveTheme(resolveThemeSetting("dark"));
    return;
  }
  applyStoredTheme(setting, stored);
}

/** Puts an already-read record in force, without touching disk again. */
export function applyStoredTheme(id: CustomThemeId, stored: StoredTheme): void {
  const base = getThemeRecord(stored.base);
  setActiveCustomTheme(id, stored.base, applyThemeOverrides(base, stored.overrides));
}
