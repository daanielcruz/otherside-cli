import { describe, expect, it } from "bun:test";
import { clipFlat } from "@/ui/transcript/tool-render/format.ts";

describe("clipFlat neutralizes control characters", () => {
  it("drops carriage returns and spaces newlines so a row cannot be corrupted", () => {
    expect(clipFlat("a\rb\nc", 20)).toBe("ab c");
  });

  it("maps ESC and other C0 controls to a space (no raw escape sequences leak)", () => {
    const out = clipFlat("a\x1b[31mb\x07c", 20);
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    expect(out).toBe("a [31mb c");
  });

  it("still ellipsizes past the max length", () => {
    expect(clipFlat("abcdef", 4)).toBe("abc…");
  });
});
