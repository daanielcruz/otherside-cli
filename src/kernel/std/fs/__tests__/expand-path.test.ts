import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandPath } from "@/kernel/std/fs/expand-path.ts";

describe("expandPath", () => {
  it("handles empty input as baseDir", () => {
    const baseDir = resolve("/base");
    expect(expandPath("  ", baseDir)).toBe(baseDir);
  });

  it("expands home shortcuts", () => {
    expect(expandPath("~")).toBe(homedir());
    expect(expandPath("~/a/b")).toBe(join(homedir(), "a", "b"));
  });
});
