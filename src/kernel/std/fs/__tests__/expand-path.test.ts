import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandPath, windowsShellPathToNative } from "@/kernel/std/fs/expand-path.ts";

describe("expandPath", () => {
  it("handles empty input as baseDir", () => {
    const baseDir = resolve("/base");
    expect(expandPath("  ", baseDir)).toBe(baseDir);
  });

  it("expands home shortcuts", () => {
    expect(expandPath("~")).toBe(homedir());
    expect(expandPath("~/a/b")).toBe(join(homedir(), "a", "b"));
  });

  it("treats environment variables and quotes literally", () => {
    expect(expandPath("$PROJECT_DIR", "/base")).toBe(resolve("/base", "$PROJECT_DIR"));
    expect(expandPath('"space dir"', "/base")).toBe(resolve("/base", '"space dir"'));
  });

  it("converts shell-style Windows drive paths", () => {
    expect(windowsShellPathToNative("/c/Users/example/project")).toBe(
      "C:\\Users\\example\\project",
    );
  });
});
