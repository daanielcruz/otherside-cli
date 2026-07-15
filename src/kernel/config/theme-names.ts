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
export type ThemeSetting = (typeof THEME_SETTINGS)[number];
