export const THEME_NAMES = [
  "dark",
  "light",
  "light-daltonized",
  "dark-daltonized",
  "light-ansi",
  "dark-ansi",
] as const;

export type ThemeName = (typeof THEME_NAMES)[number];
export const THEME_SETTINGS = ["auto", ...THEME_NAMES] as const;

/** A palette that ships with the client, plus the follow-the-terminal choice. */
export type BuiltinThemeSetting = (typeof THEME_SETTINGS)[number];

/**
 * Marks a setting that names a stored record instead of a shipped palette. The
 * slug after the prefix is the record's file stem, so the id alone locates it.
 */
export const CUSTOM_THEME_PREFIX = "custom:";

export type CustomThemeId = `${typeof CUSTOM_THEME_PREFIX}${string}`;

export type ThemeSetting = BuiltinThemeSetting | CustomThemeId;

export function isCustomThemeId(value: string): value is CustomThemeId {
  return value.startsWith(CUSTOM_THEME_PREFIX) && value.length > CUSTOM_THEME_PREFIX.length;
}

export function isBuiltinThemeSetting(value: string): value is BuiltinThemeSetting {
  return (THEME_SETTINGS as readonly string[]).includes(value);
}

export function customThemeIdFor(slug: string): CustomThemeId {
  return `${CUSTOM_THEME_PREFIX}${slug}`;
}

export function slugFromCustomThemeId(id: CustomThemeId): string {
  return id.slice(CUSTOM_THEME_PREFIX.length);
}
