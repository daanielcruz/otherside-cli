import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOutputStyles, resolveOutputStyle } from "@/engine/output-styles/loader.ts";

let base: string;
let cwd: string;
let savedConfigDir: string | undefined;

function writeStyle(dir: string, file: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body, "utf8");
}

function userStylesDir(): string {
  return join(base, "config", "output-styles");
}

function projectStylesDir(): string {
  return join(cwd, ".otherside", "output-styles");
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-output-styles-"));
  cwd = join(base, "project");
  mkdirSync(cwd, { recursive: true });
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  rmSync(base, { recursive: true, force: true });
});

describe("resolveOutputStyle", () => {
  it("resolves the default name and an empty setting to the default style", () => {
    for (const setting of ["default", undefined, "  "]) {
      const record = resolveOutputStyle(setting, cwd);
      expect(record?.name).toBe("default");
      expect(record?.keepCodingInstructions).toBe(true);
      expect(record?.prompt).toContain("Write for a reader with ADHD");
    }
  });

  it("resolves an unknown name to no style rather than a filler section", () => {
    expect(resolveOutputStyle("Nonexistent", cwd)).toBeNull();
  });

  it("resolves each built-in with its prompt and coding-instruction flag", () => {
    for (const name of ["Proactive", "Explanatory", "Learning"]) {
      const style = resolveOutputStyle(name, cwd);
      expect(style?.name).toBe(name);
      expect(style?.keepCodingInstructions).toBe(true);
      expect(style?.prompt).toContain(`# ${name} Style Active`);
    }
  });

  it("reads a custom style's frontmatter fields", () => {
    writeStyle(
      userStylesDir(),
      "terse.md",
      "---\nname: Terse\ndescription: Short answers only\nkeep-coding-instructions: true\n---\nAnswer in one sentence.\n",
    );
    const style = resolveOutputStyle("Terse", cwd);
    expect(style).toEqual({
      name: "Terse",
      description: "Short answers only",
      prompt: "Answer in one sentence.",
      source: "user",
      keepCodingInstructions: true,
    });
  });

  it("falls back to the filename and first heading when frontmatter is absent", () => {
    writeStyle(userStylesDir(), "plain.md", "# Plain speaking\nBody text.\n");
    const style = resolveOutputStyle("plain", cwd);
    expect(style?.name).toBe("plain");
    expect(style?.description).toBe("Plain speaking");
    expect(style?.keepCodingInstructions).toBeUndefined();
  });

  it("lets a project style shadow a user style of the same name", () => {
    writeStyle(userStylesDir(), "shared.md", "---\nname: Shared\n---\nUser body.\n");
    writeStyle(projectStylesDir(), "shared.md", "---\nname: Shared\n---\nProject body.\n");
    const style = resolveOutputStyle("Shared", cwd);
    expect(style?.prompt).toBe("Project body.");
    expect(style?.source).toBe("project");
  });

  it("lets a custom style shadow a built-in of the same name", () => {
    writeStyle(userStylesDir(), "Learning.md", "---\nname: Learning\n---\nMine.\n");
    expect(resolveOutputStyle("Learning", cwd)?.prompt).toBe("Mine.");
  });
});

describe("listOutputStyles", () => {
  it("lists the built-in roster with the default entry's picker face", () => {
    expect(listOutputStyles(cwd).map((option) => option.value)).toEqual([
      "default",
      "Proactive",
      "Explanatory",
      "Learning",
    ]);
    expect(listOutputStyles(cwd)[0]).toEqual({
      value: "default",
      label: "default",
      description: "ADHD - Concise dialog",
    });
  });

  it("appends custom styles after the built-ins without duplicating a shadowed name", () => {
    writeStyle(userStylesDir(), "mine.md", "---\nname: Mine\ndescription: d\n---\nBody.\n");
    writeStyle(userStylesDir(), "Learning.md", "---\nname: Learning\n---\nBody.\n");
    const values = listOutputStyles(cwd).map((option) => option.value);
    expect(values).toEqual(["default", "Proactive", "Explanatory", "Learning", "Mine"]);
  });
});
