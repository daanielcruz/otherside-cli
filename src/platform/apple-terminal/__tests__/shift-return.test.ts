import { describe, expect, it } from "bun:test";
import {
  appleTerminalShiftReader,
  isAppleTerminalShiftReturn,
  shouldProbeAppleTerminal,
} from "@/platform/apple-terminal/shift-return.ts";
import type { KeyEventData } from "@/terminal-runtime";

function keyEvent(
  name: string | undefined,
  flags: Partial<Pick<KeyEventData, "ctrl" | "meta" | "shift" | "option" | "isPasted">> = {},
): KeyEventData {
  return {
    kind: "key",
    fn: false,
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: "\r",
    raw: "\r",
    isPasted: false,
    ...flags,
  };
}

describe("shouldProbeAppleTerminal", () => {
  // The suite runs on darwin, so the env/tty legs carry the gate here.
  it("requires Apple_Terminal and a TTY", () => {
    expect(shouldProbeAppleTerminal({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBe(
      process.platform === "darwin",
    );
    expect(shouldProbeAppleTerminal({ TERM_PROGRAM: "Apple_Terminal" }, false)).toBe(false);
    expect(shouldProbeAppleTerminal({ TERM_PROGRAM: "iTerm.app" }, true)).toBe(false);
    expect(shouldProbeAppleTerminal({}, true)).toBe(false);
  });
});

describe("isAppleTerminalShiftReturn", () => {
  it("asks the reader only for an otherwise unmodified return", () => {
    let reads = 0;
    const reader = (): boolean => {
      reads += 1;
      return true;
    };
    expect(isAppleTerminalShiftReturn(keyEvent("return"), reader)).toBe(true);
    expect(reads).toBe(1);
  });

  it("never consults the reader for modified, pasted or non-return keys", () => {
    const reader = (): boolean => {
      throw new Error("must not be read");
    };
    expect(isAppleTerminalShiftReturn(keyEvent("return", { shift: true }), reader)).toBe(false);
    expect(isAppleTerminalShiftReturn(keyEvent("return", { meta: true }), reader)).toBe(false);
    expect(isAppleTerminalShiftReturn(keyEvent("return", { ctrl: true }), reader)).toBe(false);
    expect(isAppleTerminalShiftReturn(keyEvent("return", { option: true }), reader)).toBe(false);
    expect(isAppleTerminalShiftReturn(keyEvent("return", { isPasted: true }), reader)).toBe(false);
    expect(isAppleTerminalShiftReturn(keyEvent("enter"), reader)).toBe(false);
  });

  it("degrades a throwing reader to plain submit", () => {
    expect(
      isAppleTerminalShiftReturn(keyEvent("return"), () => {
        throw new Error("query denied");
      }),
    ).toBe(false);
  });
});

describe("appleTerminalShiftReader", () => {
  it("stays off outside the Apple_Terminal gate", () => {
    expect(appleTerminalShiftReader({ TERM_PROGRAM: "iTerm.app" }, true)).toBeNull();
    expect(appleTerminalShiftReader({ TERM_PROGRAM: "Apple_Terminal" }, false)).toBeNull();
    expect(appleTerminalShiftReader({}, true)).toBeNull();
  });
});
