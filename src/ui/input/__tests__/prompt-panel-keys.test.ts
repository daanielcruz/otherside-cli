import { describe, expect, it } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { promptPanelFor } from "@/ui/input/prompt-panel-keys.ts";

function keyEvent(
  name: string | undefined,
  sequence: string,
  flags: Partial<Pick<KeyEventData, "ctrl" | "meta" | "isPasted">> = {},
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
    sequence,
    raw: sequence,
    isPasted: false,
    ...flags,
  };
}

const NO_KEY_NAME = { keyName: undefined };

describe("promptPanelFor", () => {
  it("opens the model picker on meta+p, wherever the caret is", () => {
    const legacy = keyEvent(undefined, "\x1bp", { meta: true });
    expect(promptPanelFor(legacy, { keyName: "p" })).toBe("model");
    expect(promptPanelFor(keyEvent("p", "\x1bp", { meta: true }), { keyName: "p" })).toBe("model");
  });

  it("leaves ctrl+p to history navigation", () => {
    expect(promptPanelFor(keyEvent("p", "\x10", { ctrl: true }), { keyName: "p" })).toBeNull();
  });

  it("leaves ? to the buffer as an ordinary character", () => {
    expect(promptPanelFor(keyEvent(undefined, "?"), NO_KEY_NAME)).toBeNull();
  });

  it("claims nothing for an ordinary character", () => {
    expect(promptPanelFor(keyEvent(undefined, "a"), NO_KEY_NAME)).toBeNull();
  });
});
