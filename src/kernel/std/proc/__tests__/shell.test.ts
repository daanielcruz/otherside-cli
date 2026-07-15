import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { findShell, resetShellCache } from "@/kernel/std/proc/shell.ts";

function withShell(shell: string | undefined, assertion: () => void): void {
  const previousShell = process.env.SHELL;
  try {
    if (shell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = shell;
    }
    resetShellCache();
    assertion();
  } finally {
    if (previousShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = previousShell;
    }
    resetShellCache();
  }
}

describe("findShell", () => {
  it("rejects an incompatible configured shell", () => {
    withShell("/bin/csh", () => {
      expect(findShell()).toBe("/bin/sh");
      expect(findShell()).not.toBe("/bin/csh");
    });
  });

  for (const shellPath of ["/bin/bash", "/bin/zsh"]) {
    if (existsSync(shellPath)) {
      it(`honors the configured ${shellPath} shell`, () => {
        withShell(shellPath, () => {
          expect(findShell()).toBe(shellPath);
        });
      });
    }
  }

  it("falls back when SHELL is unset", () => {
    withShell(undefined, () => {
      expect(findShell()).toBe("/bin/sh");
    });
  });

  it("falls back when SHELL does not exist", () => {
    withShell("/definitely/not/a/real/shell", () => {
      expect(findShell()).toBe("/bin/sh");
    });
  });
});
