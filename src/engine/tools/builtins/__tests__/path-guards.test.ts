import { describe, expect, test } from "bun:test";
import { isNetworkSharePath } from "@/engine/tools/builtins/path-guards.ts";

describe("isNetworkSharePath", () => {
  test("rejects backslash UNC paths", () => {
    expect(isNetworkSharePath("\\\\attacker\\share\\x.txt")).toBe(true);
  });

  test("rejects forward-slash network share paths", () => {
    expect(isNetworkSharePath("//attacker/share/x.txt")).toBe(true);
  });

  test("accepts regular absolute paths", () => {
    expect(isNetworkSharePath("/Users/x/file.txt")).toBe(false);
    expect(isNetworkSharePath("C:\\Users\\x\\file.txt")).toBe(false);
  });
});
