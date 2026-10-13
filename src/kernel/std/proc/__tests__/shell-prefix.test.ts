import { describe, expect, it } from "bun:test";
import { expandShellPrefix, hasShellPrefix } from "@/kernel/std/proc/shell-prefix.ts";

describe("hasShellPrefix", () => {
  it("finds inline and block commands, and nothing in plain text", () => {
    expect(hasShellPrefix("Branch: !`git branch`")).toBe(true);
    expect(hasShellPrefix("```!\ngit status\n```")).toBe(true);
    expect(hasShellPrefix("Say hi! Then `run tests`.")).toBe(false);
    expect(hasShellPrefix("Plain instructions.")).toBe(false);
  });
});

describe("expandShellPrefix", () => {
  it("inserts command output verbatim even when it contains $-substitution patterns", async () => {
    // `$&`/`$1`/`$$` in the output must NOT be reinterpreted as String.replace
    // replacement patterns (which would splice in the matched text).
    const out = await expandShellPrefix("pre !`printf '%s' '$& $1 $$'` post");
    expect(out).toBe("pre $& $1 $$ post");
  });
});
