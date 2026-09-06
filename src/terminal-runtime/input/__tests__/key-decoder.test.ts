import { describe, expect, it } from "bun:test";
import {
  decodeTerminalInput,
  FRESH_INPUT_DECODE_STATE,
} from "@/terminal-runtime/input/key-decoder.ts";
import { PASTE_END, PASTE_START } from "@/terminal-runtime/terminal/control-sequences.ts";

describe("terminal input decoding", () => {
  it("emits text keys, focus changes, and atomic pastes", () => {
    const [textEvents] = decodeTerminalInput(FRESH_INPUT_DECODE_STATE, "A");
    expect(textEvents).toEqual([
      expect.objectContaining({ kind: "key", name: "a", shift: true, sequence: "A" }),
    ]);

    const [focusEvents] = decodeTerminalInput(FRESH_INPUT_DECODE_STATE, "\x1b[I\x1b[O");
    expect(focusEvents).toEqual([
      { kind: "focus", focused: true },
      { kind: "focus", focused: false },
    ]);

    const [pasteEvents] = decodeTerminalInput(
      FRESH_INPUT_DECODE_STATE,
      `${PASTE_START}line one\nline two${PASTE_END}`,
    );
    expect(pasteEvents).toEqual([
      expect.objectContaining({
        kind: "key",
        isPasted: true,
        name: "",
        sequence: "line one\nline two",
      }),
    ]);
  });

  it("retains split control input and drains a lone escape", () => {
    const [partialEvents, partialState] = decodeTerminalInput(FRESH_INPUT_DECODE_STATE, "\x1b[");
    expect(partialEvents).toEqual([]);
    expect(partialState.pending).toBe("\x1b[");

    const [arrowEvents, completeState] = decodeTerminalInput(partialState, "A");
    expect(arrowEvents).toEqual([
      expect.objectContaining({ kind: "key", name: "up", sequence: "\x1b[A" }),
    ]);
    expect(completeState.pending).toBe("");

    const [, escapeState] = decodeTerminalInput(FRESH_INPUT_DECODE_STATE, "\x1b");
    const [escapeEvents] = decodeTerminalInput(escapeState, null);
    expect(escapeEvents).toEqual([
      expect.objectContaining({ kind: "key", name: "escape", sequence: "\x1b" }),
    ]);
  });

  it("swallows terminal query replies that have no active request owner", () => {
    const replies = [
      "\x1b[?2026;1$y",
      "\x1b[?997;1n",
      "\x1b[?1;2c",
      "\x1b[>1;2c",
      "\x1b[?3u",
      "\x1b[?17;8R",
      "\x1b]11;rgb:ffff/ffff/ffff\x07",
      "\x1bP>|xterm.js(5.5.0)\x1b\\",
    ];

    for (const reply of replies) {
      expect(decodeTerminalInput(FRESH_INPUT_DECODE_STATE, reply)[0]).toEqual([]);
    }
  });
});
