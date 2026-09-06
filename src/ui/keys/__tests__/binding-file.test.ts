import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeBindings,
  BINDING_FILE_TEMPLATE,
  bindingFilePath,
  bindingProblems,
  ensureBindingFile,
  reloadBindings,
  resetBindingsForTests,
} from "@/ui/keys/binding-file.ts";
import { DEFAULT_BINDINGS } from "@/ui/keys/defaults.ts";

// The scratch is rooted in the system temp dir and owned by this file: the suite
// shares one process, so a config dir another file set is that file's to remove.
let scratch: string;
let priorConfigDir: string | undefined;

beforeEach(() => {
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  scratch = mkdtempSync(join(tmpdir(), "otherside-bindings-"));
  process.env.OTHERSIDE_CONFIG_DIR = scratch;
  resetBindingsForTests();
});

afterEach(() => {
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  rmSync(scratch, { recursive: true, force: true });
  resetBindingsForTests();
});

function writeFile(contents: string): void {
  writeFileSync(bindingFilePath(), contents, "utf8");
}

describe("reading the binding file", () => {
  test("uses the shipped table and says nothing when no file exists", () => {
    const loaded = reloadBindings();
    expect(loaded.fromFile).toBe(false);
    expect(loaded.problems).toEqual([]);
    expect(activeBindings()).toBe(DEFAULT_BINDINGS);
  });

  test("puts a file's table in force", () => {
    writeFile(
      JSON.stringify({ bindings: [{ context: "select", bindings: { n: "select:next" } }] }),
    );
    reloadBindings();
    expect(activeBindings().select?.n).toBe("select:next");
    expect(bindingProblems()).toEqual([]);
  });

  test("keeps every key when the file will not parse", () => {
    writeFile("{ this is not json");
    const loaded = reloadBindings();
    // A reader mid-edit must not lose the keys they were not editing.
    expect(loaded.table).toBe(DEFAULT_BINDINGS);
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]?.message).toContain("no binding changed");
  });

  test("carries the refusals forward for whoever reports them", () => {
    writeFile(
      JSON.stringify({ bindings: [{ context: "select", bindings: { "ctrl+c": "select:next" } }] }),
    );
    reloadBindings();
    expect(bindingProblems()).toHaveLength(1);
    expect(bindingProblems()[0]?.message).toContain("reserved");
  });

  test("ignores a comment key, which is what a template puts there", () => {
    writeFile(BINDING_FILE_TEMPLATE);
    const loaded = reloadBindings();
    expect(loaded.problems).toEqual([]);
  });
});

describe("making a file to edit", () => {
  test("writes the template when none exists", () => {
    const { path, created } = ensureBindingFile();
    expect(created).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(BINDING_FILE_TEMPLATE);
  });

  test("never writes over one that exists", () => {
    writeFile('{ "bindings": [] }');
    const { created } = ensureBindingFile();
    expect(created).toBe(false);
    expect(readFileSync(bindingFilePath(), "utf8")).toBe('{ "bindings": [] }');
  });
});
