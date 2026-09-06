import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOutputStyles, resolveOutputStyle } from "@/engine/output-styles/loader.ts";
import { clear as clearPlugins, register } from "@/engine/plugins/registry.ts";

// Owned by this file: the suite shares one process, so the registry and the two
// path env vars another file set are that file's to restore.
let base: string;
let cwd: string;
let priorConfigDir: string | undefined;
let priorPolicyDir: string | undefined;

function writeStyle(dir: string, file: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body, "utf8");
}

function registerPlugin(name: string): string {
  const root = join(base, "plugins", name);
  const outputStylesPath = join(root, "output-styles");
  mkdirSync(outputStylesPath, { recursive: true });
  register({ name, path: root, source: "test", manifest: { name }, outputStylesPath });
  return outputStylesPath;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-style-tiers-"));
  cwd = join(base, "project");
  mkdirSync(cwd, { recursive: true });
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  priorPolicyDir = process.env.OTHERSIDE_POLICY_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
  process.env.OTHERSIDE_POLICY_DIR = join(base, "policy");
  clearPlugins();
});

afterEach(() => {
  clearPlugins();
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  if (priorPolicyDir === undefined) delete process.env.OTHERSIDE_POLICY_DIR;
  else process.env.OTHERSIDE_POLICY_DIR = priorPolicyDir;
  rmSync(base, { recursive: true, force: true });
});

describe("a style a plugin ships", () => {
  test("is named after the plugin, so two of them shipping one name stay two styles", () => {
    writeStyle(registerPlugin("scribe"), "concise.md", "Say less.");
    writeStyle(registerPlugin("editor"), "concise.md", "Cut harder.");

    const names = listOutputStyles(cwd).map((option) => option.value);
    expect(names).toContain("scribe:concise");
    expect(names).toContain("editor:concise");
    expect(resolveOutputStyle("scribe:concise", cwd)?.prompt).toBe("Say less.");
  });

  test("carries its frontmatter the way any other custom style does", () => {
    writeStyle(
      registerPlugin("scribe"),
      "terse.md",
      "---\nname: Terse\ndescription: Fewer words\nkeep-coding-instructions: true\n---\nBe brief.",
    );

    const style = resolveOutputStyle("scribe:Terse", cwd);
    expect(style?.description).toBe("Fewer words");
    expect(style?.keepCodingInstructions).toBe(true);
    expect(style?.source).toBe("plugin");
  });

  test("gives way to a style the reader wrote under the same name", () => {
    writeStyle(registerPlugin("scribe"), "concise.md", "From the plugin.");
    writeStyle(join(base, "config", "output-styles"), "scribe:concise.md", "From the reader.");

    expect(resolveOutputStyle("scribe:concise", cwd)?.prompt).toBe("From the reader.");
  });
});

describe("a style a plugin insists on", () => {
  test("stands in for whatever the reader chose", () => {
    writeStyle(
      registerPlugin("scribe"),
      "voice.md",
      "---\nforce-for-plugin: true\n---\nOnly this voice.",
    );

    // The setting names a built-in and is overruled: the plugin's prompt only
    // works under the voice it ships.
    expect(resolveOutputStyle("default", cwd)?.prompt).toBe("Only this voice.");
  });

  test("is a plugin's alone — the same flag on the reader's style means nothing", () => {
    writeStyle(
      join(base, "config", "output-styles"),
      "mine.md",
      "---\nforce-for-plugin: true\n---\nMine.",
    );

    expect(resolveOutputStyle("default", cwd)?.name).toBe("default");
  });
});

describe("a style managed policy ships", () => {
  test("overrides the reader and the project both, because an administrator set it", () => {
    writeStyle(join(base, "config", "output-styles"), "house.md", "The reader's.");
    writeStyle(join(cwd, ".otherside", "output-styles"), "house.md", "The project's.");
    writeStyle(join(base, "policy", "output-styles"), "house.md", "The administrator's.");

    const style = resolveOutputStyle("house", cwd);
    expect(style?.prompt).toBe("The administrator's.");
    expect(style?.source).toBe("policy");
  });

  test("is absent when no policy directory was deployed", () => {
    writeStyle(join(base, "config", "output-styles"), "house.md", "The reader's.");
    expect(resolveOutputStyle("house", cwd)?.source).toBe("user");
  });
});

describe("a style directory the manifest names", () => {
  test("is read beside the plugin's own", () => {
    const root = join(base, "plugins", "scribe");
    const extra = join(root, "voices");
    mkdirSync(join(root, "output-styles"), { recursive: true });
    mkdirSync(extra, { recursive: true });
    writeStyle(join(root, "output-styles"), "default-place.md", "From the default place.");
    writeStyle(extra, "named-place.md", "From the named place.");
    register({
      name: "scribe",
      path: root,
      source: "test",
      manifest: { name: "scribe" },
      outputStylesPath: join(root, "output-styles"),
      outputStylesPaths: [extra],
    });

    const names = listOutputStyles(cwd).map((option) => option.value);
    expect(names).toContain("scribe:default-place");
    expect(names).toContain("scribe:named-place");
  });

  test("can be one file rather than a directory holding it", () => {
    const root = join(base, "plugins", "scribe");
    mkdirSync(root, { recursive: true });
    writeStyle(root, "lone.md", "Just the one.");
    register({
      name: "scribe",
      path: root,
      source: "test",
      manifest: { name: "scribe" },
      outputStylesPaths: [join(root, "lone.md")],
    });

    expect(resolveOutputStyle("scribe:lone", cwd)?.prompt).toBe("Just the one.");
  });
});
