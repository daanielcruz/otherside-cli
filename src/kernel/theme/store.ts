import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { THEME_NAMES, type ThemeName } from "@/kernel/config/theme-names.ts";
import { customThemesDir } from "@/kernel/std/fs/paths.ts";

/**
 * Where a stored theme was discovered. Records bundled with a plugin are read
 * but never written back, so the editor refuses to save onto them.
 */
export type CustomThemeSource = "user" | "plugin";

/**
 * A stored theme as it exists on disk, before any of it is read as colour. Slot
 * values stay strings here: the kernel owns the file, the render layer owns what
 * a value means.
 */
export interface StoredTheme {
  /** File stem, and the tail of the setting id that selects this theme. */
  slug: string;
  name: string;
  base: ThemeName;
  overrides: Readonly<Record<string, string>>;
  source: CustomThemeSource;
}

const FILE_SUFFIX = ".json";

/**
 * Folds a display name into a file stem. Runs of anything that is not a letter
 * or digit collapse to a single dash so two names never differ only by spacing.
 */
export function themeSlug(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function customThemePath(slug: string): string {
  return join(customThemesDir(), `${slug}${FILE_SUFFIX}`);
}

function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value);
}

/**
 * Reads one record's parsed JSON. A record missing a usable name or base is
 * rejected whole, because neither can be guessed; a slot whose value is not a
 * string is dropped on its own so one bad entry cannot cost the rest.
 */
export function readStoredTheme(
  slug: string,
  raw: unknown,
  source: CustomThemeSource,
): StoredTheme | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name.length === 0) return undefined;
  if (!isThemeName(record.base)) return undefined;

  const overrides: Record<string, string> = {};
  const rawOverrides = record.overrides;
  if (typeof rawOverrides === "object" && rawOverrides !== null) {
    for (const [key, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
      if (typeof value === "string") overrides[key] = value;
    }
  }
  return { slug, name, base: record.base, overrides, source };
}

function loadFile(dir: string, file: string, source: CustomThemeSource): StoredTheme | undefined {
  if (!file.endsWith(FILE_SUFFIX)) return undefined;
  const slug = file.slice(0, -FILE_SUFFIX.length);
  if (slug.length === 0) return undefined;
  try {
    return readStoredTheme(slug, JSON.parse(readFileSync(join(dir, file), "utf8")), source);
  } catch {
    return undefined;
  }
}

/**
 * Every readable record in one directory, sorted by display name. An unreadable
 * or malformed file is skipped rather than surfaced: this runs on the boot path,
 * where the theme falling back to a shipped palette is the only failure worth
 * accepting.
 *
 * The prefix names the contributor a record came from, so two of them shipping
 * "Midnight" stay two records with a slug each that still locates its file.
 */
export function readStoredThemesFrom(
  target: string,
  source: CustomThemeSource,
  prefix = "",
): StoredTheme[] {
  let dir = target;
  let files: string[];
  try {
    // A path may name one record instead of a directory of them.
    if (statSync(target).isFile()) {
      dir = dirname(target);
      files = [basename(target)];
    } else {
      files = readdirSync(target);
    }
  } catch {
    return [];
  }
  const themes: StoredTheme[] = [];
  for (const file of files) {
    const theme = loadFile(dir, file, source);
    if (!theme) continue;
    themes.push(
      prefix.length === 0
        ? theme
        : { ...theme, slug: prefix + theme.slug, name: prefix + theme.name },
    );
  }
  return themes.sort((a, b) => a.name.localeCompare(b.name));
}

/** The reader's own records. A plugin's are composed on top of these upstack. */
export function listStoredThemes(): StoredTheme[] {
  return readStoredThemesFrom(customThemesDir(), "user");
}

export function readStoredThemeBySlug(slug: string): StoredTheme | undefined {
  try {
    return readStoredTheme(slug, JSON.parse(readFileSync(customThemePath(slug), "utf8")), "user");
  } catch {
    return undefined;
  }
}

/** Writes a record, creating the directory on first use. */
export function writeStoredTheme(theme: StoredTheme): void {
  mkdirSync(customThemesDir(), { recursive: true });
  const body = { name: theme.name, base: theme.base, overrides: theme.overrides };
  writeFileSync(customThemePath(theme.slug), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export function deleteStoredTheme(slug: string): void {
  rmSync(customThemePath(slug), { force: true });
}
