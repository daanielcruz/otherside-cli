import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDirectoryFeedback, readDirectoryArgument } from "@/commands/handlers/add-dir.ts";

let base: string;
let cwd: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-add-dir-"));
  cwd = join(base, "workspace");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("what a path resolves to", () => {
  test("a directory outside everything reachable is the one that gets added", () => {
    const shared = join(base, "shared");
    mkdirSync(shared);
    expect(readDirectoryArgument(shared, [], cwd)).toEqual({ kind: "added", path: shared });
  });

  test("a trailing slash names the same directory, not a second one", () => {
    const shared = join(base, "shared");
    mkdirSync(shared);
    const outcome = readDirectoryArgument(`${shared}/`, [], cwd);
    expect(outcome).toEqual({ kind: "added", path: shared });
  });

  test("a relative path is read against the working directory", () => {
    mkdirSync(join(cwd, "vendor"));
    // Inside the cwd, so it is already reachable rather than something to add.
    expect(readDirectoryArgument("vendor", [], cwd).kind).toBe("already");
  });

  test("nothing written is nothing to add", () => {
    expect(readDirectoryArgument("   ", [], cwd)).toEqual({ kind: "empty" });
  });
});

describe("what cannot be added", () => {
  test("a path that is not there", () => {
    const outcome = readDirectoryArgument(join(base, "ghost"), [], cwd);
    expect(outcome.kind).toBe("missing");
  });

  test("a file, which is named with the directory holding it", () => {
    const file = join(base, "notes.md");
    writeFileSync(file, "hello", "utf8");
    const outcome = readDirectoryArgument(file, [], cwd);
    expect(outcome.kind).toBe("not-a-directory");
    expect(addDirectoryFeedback(outcome)).toContain(base);
  });
});

describe("what is already reachable", () => {
  test("the working directory itself", () => {
    const outcome = readDirectoryArgument(cwd, [], cwd);
    expect(outcome).toMatchObject({ kind: "already", exact: true, isCwd: true });
    expect(addDirectoryFeedback(outcome)).toContain("already the working directory");
  });

  test("a directory under one already granted, named by what holds it", () => {
    const shared = join(base, "shared");
    const nested = join(shared, "inner");
    mkdirSync(nested, { recursive: true });

    const outcome = readDirectoryArgument(nested, [shared], cwd);
    expect(outcome).toMatchObject({ kind: "already", exact: false, within: shared });
    expect(addDirectoryFeedback(outcome)).toContain(shared);
  });

  test("a sibling whose name merely starts the same is not inside it", () => {
    // `/base/shared-extra` is not under `/base/shared`, and a prefix test that
    // forgot the separator would say it was.
    const shared = join(base, "shared");
    const sibling = join(base, "shared-extra");
    mkdirSync(shared);
    mkdirSync(sibling);

    expect(readDirectoryArgument(sibling, [shared], cwd)).toEqual({
      kind: "added",
      path: sibling,
    });
  });
});
