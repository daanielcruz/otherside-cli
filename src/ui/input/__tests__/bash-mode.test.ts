import { describe, expect, it } from "bun:test";
import { entersBashMode, exitsBashMode } from "@/ui/input/bash-mode.ts";

describe("entersBashMode", () => {
  it("enters on `!` typed into an empty prompt", () => {
    expect(entersBashMode({ key: "!", buffer: "", cursor: 0, bashMode: false })).toBe(true);
  });

  it("inserts normally when the buffer already has content", () => {
    expect(entersBashMode({ key: "!", buffer: "echo", cursor: 4, bashMode: false })).toBe(false);
    expect(entersBashMode({ key: "!", buffer: "echo", cursor: 0, bashMode: false })).toBe(false);
  });

  it("inserts normally while the mode is already active", () => {
    expect(entersBashMode({ key: "!", buffer: "", cursor: 0, bashMode: true })).toBe(false);
  });

  it("ignores other keys", () => {
    expect(entersBashMode({ key: "a", buffer: "", cursor: 0, bashMode: false })).toBe(false);
  });
});

describe("exitsBashMode", () => {
  it("exits at offset 0 while active", () => {
    expect(exitsBashMode({ cursor: 0, bashMode: true })).toBe(true);
  });

  it("stays active away from offset 0", () => {
    expect(exitsBashMode({ cursor: 3, bashMode: true })).toBe(false);
  });

  it("is inert when the mode is off", () => {
    expect(exitsBashMode({ cursor: 0, bashMode: false })).toBe(false);
  });
});
