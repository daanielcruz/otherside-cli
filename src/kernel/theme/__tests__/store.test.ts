import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  customThemeIdFor,
  isBuiltinThemeSetting,
  isCustomThemeId,
  slugFromCustomThemeId,
} from "@/kernel/config/theme-names.ts";
import {
  listStoredThemes,
  readStoredTheme,
  readStoredThemeBySlug,
  themeSlug,
  writeStoredTheme,
} from "@/kernel/theme/store.ts";

let root = "";
let previous: string | undefined;

function writeRecord(slug: string, body: unknown): void {
  const dir = join(root, "themes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify(body), "utf8");
}

beforeEach(() => {
  previous = process.env.OTHERSIDE_CONFIG_DIR;
  root = mkdtempSync(join(tmpdir(), "theme-store-"));
  process.env.OTHERSIDE_CONFIG_DIR = root;
});

afterEach(() => {
  if (previous === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

describe("stored theme ids", () => {
  it("tells a stored id from a shipped one", () => {
    expect(isCustomThemeId("custom:ocean")).toBe(true);
    expect(isCustomThemeId("custom:")).toBe(false);
    expect(isCustomThemeId("dark")).toBe(false);
    expect(isBuiltinThemeSetting("dark")).toBe(true);
    expect(isBuiltinThemeSetting("custom:ocean")).toBe(false);
  });

  it("round-trips a slug through its id", () => {
    expect(customThemeIdFor("ocean-blue")).toBe("custom:ocean-blue");
    expect(slugFromCustomThemeId("custom:ocean-blue")).toBe("ocean-blue");
  });
});

describe("slug derivation", () => {
  it("folds a display name into a file stem", () => {
    expect(themeSlug("Ocean Blue Deep")).toBe("ocean-blue-deep");
    expect(themeSlug("  Trailing  Spaces  ")).toBe("trailing-spaces");
    expect(themeSlug("Punctuation!!! Here")).toBe("punctuation-here");
  });

  it("gives an unusable name an empty stem", () => {
    expect(themeSlug("")).toBe("");
    expect(themeSlug("!!!")).toBe("");
  });
});

describe("record validation", () => {
  it("refuses a record with no usable name or base", () => {
    expect(readStoredTheme("x", { base: "dark" }, "user")).toBeUndefined();
    expect(readStoredTheme("x", { name: "  ", base: "dark" }, "user")).toBeUndefined();
    expect(readStoredTheme("x", { name: "A", base: "nonesuch" }, "user")).toBeUndefined();
    expect(readStoredTheme("x", null, "user")).toBeUndefined();
  });

  it("keeps the readable slots and drops the rest", () => {
    const theme = readStoredTheme(
      "x",
      { name: "A", base: "dark", overrides: { text: "#FF0000", broken: 7 } },
      "user",
    );
    expect(theme?.overrides).toEqual({ text: "#FF0000" });
  });

  it("treats a missing override map as no overrides", () => {
    expect(readStoredTheme("x", { name: "A", base: "dark" }, "user")?.overrides).toEqual({});
  });
});

describe("discovery", () => {
  it("reports nothing when the directory is absent", () => {
    expect(listStoredThemes()).toEqual([]);
  });

  it("skips a malformed file instead of failing the listing", () => {
    writeRecord("good", { name: "Good", base: "dark", overrides: {} });
    mkdirSync(join(root, "themes"), { recursive: true });
    writeFileSync(join(root, "themes", "broken.json"), "{ not json", "utf8");
    writeRecord("nameless", { base: "dark" });

    const themes = listStoredThemes();
    expect(themes.map((t) => t.slug)).toEqual(["good"]);
  });

  it("sorts by display name", () => {
    writeRecord("b", { name: "Beta", base: "dark" });
    writeRecord("a", { name: "Alpha", base: "light" });
    expect(listStoredThemes().map((t) => t.name)).toEqual(["Alpha", "Beta"]);
  });
});

describe("writing", () => {
  it("round-trips a record through disk", () => {
    writeStoredTheme({
      slug: "ocean",
      name: "Ocean",
      base: "dark",
      overrides: { text: "#FF0000" },
      source: "user",
    });
    const read = readStoredThemeBySlug("ocean");
    expect(read?.name).toBe("Ocean");
    expect(read?.base).toBe("dark");
    expect(read?.overrides).toEqual({ text: "#FF0000" });
  });

  it("keeps the slots a later write carries over", () => {
    writeStoredTheme({
      slug: "ocean",
      name: "Ocean",
      base: "dark",
      overrides: { text: "#FF0000", muted: "ansi:green" },
      source: "user",
    });
    const first = readStoredThemeBySlug("ocean");
    writeStoredTheme({ ...first!, overrides: { ...first!.overrides, error: "#00FF00" } });
    expect(readStoredThemeBySlug("ocean")?.overrides).toEqual({
      text: "#FF0000",
      muted: "ansi:green",
      error: "#00FF00",
    });
  });
});
