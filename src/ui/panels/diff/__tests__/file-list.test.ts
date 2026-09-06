import { describe, expect, test } from "bun:test";
import { patchLineForPath, statusPath, steppedCursor } from "@/ui/panels/diff/file-list.ts";

describe("the path inside a status row", () => {
  test("is what follows the two status columns", () => {
    expect(statusPath(" M src/main.ts")).toBe("src/main.ts");
    expect(statusPath("?? docs/new.md")).toBe("docs/new.md");
    expect(statusPath("A  src/added.ts")).toBe("src/added.ts");
  });

  test("of a rename is where the file ended up, not where it was", () => {
    expect(statusPath("R  src/old.ts -> src/new.ts")).toBe("src/new.ts");
  });

  test("is nothing when the row carries none", () => {
    expect(statusPath("   ")).toBeNull();
    expect(statusPath("")).toBeNull();
  });
});

describe("finding a file in the patch", () => {
  const patch = [
    "diff --git a/src/one.ts b/src/one.ts",
    "@@ -1 +1 @@",
    "-a",
    "diff --git a/src/two.ts b/src/two.ts",
    "@@ -1 +1 @@",
    "-b",
  ];

  test("answers where its hunk begins", () => {
    expect(patchLineForPath(patch, "src/two.ts")).toBe(3);
    expect(patchLineForPath(patch, "src/one.ts")).toBe(0);
  });

  test("answers nothing for a file the patch does not carry", () => {
    // Staged-only and untracked files are listed but have no unstaged hunk.
    expect(patchLineForPath(patch, "src/three.ts")).toBeNull();
  });

  test("does not match a file whose name merely ends the same", () => {
    expect(patchLineForPath(patch, "one.ts")).toBeNull();
  });
});

describe("walking the list", () => {
  test("stops at both ends rather than wrapping", () => {
    expect(steppedCursor(0, -1, 3)).toBe(0);
    expect(steppedCursor(2, 1, 3)).toBe(2);
    expect(steppedCursor(1, 1, 3)).toBe(2);
  });

  test("is at the top when there is nothing to walk", () => {
    expect(steppedCursor(4, 1, 0)).toBe(0);
  });
});
