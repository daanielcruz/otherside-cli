import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { restoreTerminalModes } from "./gracefulShutdown.ts";

// restoreTerminalModes must reset every private DEC mode the TUI enables, so a
// signal/crash exit can't strand the terminal in raw/paste/focus/theme-notify
// mode. The theme-notify (2031) reset is the one that otherwise leaks `[?997…`
// prompts into the shell after the CLI dies.

afterEach(() => {
  (fs.writeSync as unknown as { mockRestore?: () => void }).mockRestore?.();
});

function captureRestoreOutput(): string {
  let out = "";
  spyOn(fs, "writeSync").mockImplementation(((
    fd: number,
    data: string | NodeJS.ArrayBufferView,
  ) => {
    if (fd === 1 && typeof data === "string") out += data;
    return typeof data === "string"
      ? Buffer.byteLength(data)
      : (data as ArrayBufferView).byteLength;
  }) as typeof fs.writeSync);
  restoreTerminalModes();
  return out;
}

describe("restoreTerminalModes", () => {
  it("disables theme-notify (2031) so it can't leak [?997 prompts post-exit", () => {
    expect(captureRestoreOutput()).toContain("\x1B[?2031l");
  });

  it("resets every mode the raw-mode path enables", () => {
    const out = captureRestoreOutput();
    expect(out).toContain("\x1B[?1004l"); // focus events off
    expect(out).toContain("\x1B[?2004l"); // bracketed paste off
    expect(out).toContain("\x1B[>4m"); // modify-other-keys off
    expect(out).toContain("\x1B[<u"); // kitty keyboard off
    expect(out).toContain("\x1B[?25h"); // show cursor
  });

  it("never throws even when the write fails (best-effort on a dying process)", () => {
    spyOn(fs, "writeSync").mockImplementation((() => {
      throw new Error("EPIPE");
    }) as typeof fs.writeSync);
    expect(() => restoreTerminalModes()).not.toThrow();
  });
});
