import { describe, expect, it } from "bun:test";
import { detectHyperlinkCapability } from "@/terminal-runtime/terminal/link-capability.ts";

describe("detectHyperlinkCapability", () => {
  it("recognizes Ghostty through TERM", () => {
    expect(
      detectHyperlinkCapability({
        env: { TERM: "xterm-ghostty" },
        stdoutSupported: false,
      }),
    ).toBe(true);
  });

  it("recognizes WezTerm and VS Code through TERM_PROGRAM", () => {
    for (const termProgram of ["WezTerm", "vscode"]) {
      expect(
        detectHyperlinkCapability({
          env: { TERM_PROGRAM: termProgram },
          stdoutSupported: false,
        }),
      ).toBe(true);
    }
  });
});
