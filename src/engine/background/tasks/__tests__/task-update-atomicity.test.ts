import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyTaskUpdate,
  clearAll,
  create,
  get,
  taskListIdForScope,
} from "@/engine/background/tasks/index.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";

describe("applyTaskUpdate", () => {
  let tempBaseDir: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    tempBaseDir = mkdtempSync(join(tmpdir(), "otherside-task-atomicity-"));
    savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(tempBaseDir, "config");
    clearAll();
  });

  afterEach(() => {
    clearAll();
    if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
    rmSync(tempBaseDir, { recursive: true, force: true });
  });

  test("a dependency lands on both of its tasks", () => {
    create({ subject: "first", description: "d" });
    create({ subject: "second", description: "d" });

    const outcome = applyTaskUpdate("1", { status: "in_progress" }, [["1", "2"]]);

    expect(outcome?.blocksChanged).toBe(true);
    expect(get("1")?.blocks).toEqual(["2"]);
    expect(get("2")?.blockedBy).toEqual(["1"]);
    expect(get("1")?.status).toBe("in_progress");
  });

  test("edges naming the updated task as the blocked side report blockedBy", () => {
    create({ subject: "first", description: "d" });
    create({ subject: "second", description: "d" });

    const outcome = applyTaskUpdate("1", {}, [["2", "1"]]);

    expect(outcome?.blockedByChanged).toBe(true);
    expect(outcome?.blocksChanged).toBe(false);
    expect(get("1")?.blockedBy).toEqual(["2"]);
    expect(get("2")?.blocks).toEqual(["1"]);
  });

  test("a write failing part-way leaves neither the patch nor a one-sided edge", () => {
    create({ subject: "first", description: "d" });
    create({ subject: "second", description: "d" });
    applyTaskUpdate("1", { subject: "before" }, []);

    // Task 2's record cannot be written once a directory sits on its path, so the
    // batch fails only after task 1 has already been written.
    const dir = join(configRoot(), "tasks", taskListIdForScope());
    const blockedPath = join(dir, "2");
    rmSync(blockedPath, { force: true });
    mkdirSync(blockedPath);

    expect(() => applyTaskUpdate("1", { subject: "after" }, [["1", "2"]])).toThrow();

    rmSync(blockedPath, { recursive: true, force: true });
    clearAll();

    // Rehydrated from disk: task 1 kept neither the patch nor the half of the
    // dependency whose other side never landed.
    expect(get("1")?.subject).toBe("before");
    expect(get("1")?.blocks).toEqual([]);
  });
});
