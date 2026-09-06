import { afterEach, describe, expect, it } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import {
  armCtrlXChord,
  CTRL_X_CHORD_WINDOW_MS,
  continuesCtrlXChord,
  ctrlXChordArmed,
  isCtrlXPrefix,
  releaseCtrlXChord,
  takeCtrlXChord,
} from "@/ui/input/ctrl-x-chord.ts";

function key(name: string, ctrl = true): Pick<KeyEventData, "ctrl" | "name"> {
  return { name, ctrl };
}

afterEach(() => {
  releaseCtrlXChord();
});

describe("the Ctrl+X prefix", () => {
  it("reads only Ctrl+X as the prefix", () => {
    expect(isCtrlXPrefix(key("x"))).toBe(true);
    expect(isCtrlXPrefix(key("x", false))).toBe(false);
    expect(isCtrlXPrefix(key("k"))).toBe(false);
  });

  it("names the keys that finish it", () => {
    expect(continuesCtrlXChord(key("k"))).toBe(true);
    expect(continuesCtrlXChord(key("e"))).toBe(true);
    expect(continuesCtrlXChord(key("g"))).toBe(false);
    expect(continuesCtrlXChord(key("k", false))).toBe(false);
  });

  it("holds the prefix for the whole window and drops it after", () => {
    const armedAt = 1_000_000;
    armCtrlXChord(armedAt);

    expect(ctrlXChordArmed(armedAt + CTRL_X_CHORD_WINDOW_MS)).toBe(true);
    expect(ctrlXChordArmed(armedAt + CTRL_X_CHORD_WINDOW_MS + 1)).toBe(false);
  });

  it("lets exactly one continuation claim it", () => {
    const armedAt = 2_000_000;
    armCtrlXChord(armedAt);

    expect(takeCtrlXChord(armedAt + 10)).toBe(true);
    expect(takeCtrlXChord(armedAt + 20)).toBe(false);
  });

  it("reports nothing pending once released", () => {
    armCtrlXChord();
    releaseCtrlXChord();

    expect(ctrlXChordArmed()).toBe(false);
  });
});
