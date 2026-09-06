import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clear as clearPlugins, register } from "@/engine/plugins/registry.ts";
import { findAvailableTheme, listAvailableThemes } from "@/ui/theme/custom/catalog.ts";

// Owned by this file: the suite shares one process, so the registry and the
// config dir another file set are that file's to restore.
let base: string;
let priorConfigDir: string | undefined;

function writeTheme(dir: string, slug: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.json`),
    JSON.stringify({ name, base: "dark", overrides: { text: "#ffffff" } }),
    "utf8",
  );
}

function userThemesDir(): string {
  return join(base, "config", "themes");
}

function registerPlugin(name: string): string {
  const root = join(base, "plugins", name);
  const themesPath = join(root, "themes");
  mkdirSync(themesPath, { recursive: true });
  register({ name, path: root, source: "test", manifest: { name }, themesPath });
  return themesPath;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-theme-catalog-"));
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
  clearPlugins();
});

afterEach(() => {
  clearPlugins();
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  rmSync(base, { recursive: true, force: true });
});

describe("what the picker can offer", () => {
  test("holds the reader's records and every enabled plugin's, by name", () => {
    writeTheme(userThemesDir(), "mine", "Mine");
    writeTheme(registerPlugin("dusk"), "midnight", "Midnight");

    expect(listAvailableThemes().map((theme) => theme.name)).toEqual(["dusk:Midnight", "Mine"]);
  });

  test("keeps two plugins shipping one name apart", () => {
    writeTheme(registerPlugin("dusk"), "midnight", "Midnight");
    writeTheme(registerPlugin("dawn"), "midnight", "Midnight");

    const slugs = listAvailableThemes().map((theme) => theme.slug);
    expect(slugs).toEqual(["dawn:midnight", "dusk:midnight"]);
  });

  test("says where a record came from, which is what makes a plugin's read-only", () => {
    writeTheme(userThemesDir(), "mine", "Mine");
    writeTheme(registerPlugin("dusk"), "midnight", "Midnight");

    const bySource = Object.fromEntries(
      listAvailableThemes().map((theme) => [theme.slug, theme.source]),
    );
    expect(bySource).toEqual({ mine: "user", "dusk:midnight": "plugin" });
  });

  test("drops a plugin's records the moment nothing is registered", () => {
    writeTheme(registerPlugin("dusk"), "midnight", "Midnight");
    clearPlugins();

    expect(listAvailableThemes()).toHaveLength(0);
  });
});

describe("finding the record a setting names", () => {
  test("reaches a plugin's as readily as the reader's", () => {
    writeTheme(registerPlugin("dusk"), "midnight", "Midnight");

    expect(findAvailableTheme("dusk:midnight")?.base).toBe("dark");
    expect(findAvailableTheme("midnight")).toBeUndefined();
  });
});
