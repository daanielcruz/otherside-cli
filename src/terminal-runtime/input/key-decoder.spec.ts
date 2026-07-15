import { describe, expect, test } from "bun:test";
import { INITIAL_PARSER_STATE, parseInputSequence } from "@/terminal-runtime/input/key-decoder.ts";
import App from "@/terminal-runtime/react/runtime-root.tsx";

describe("parse-keypress bracketed paste", () => {
  test("happy path paste", () => {
    const [events1, state1] = parseInputSequence(INITIAL_PARSER_STATE, "\x1b[200~");
    expect(state1.mode).toBe("IN_PASTE");
    expect(events1.length).toBe(0);

    const [events2, state2] = parseInputSequence(state1, "hello world");
    expect(state2.mode).toBe("IN_PASTE");
    expect(state2.pasteBuffer).toBe("hello world");
    expect(events2.length).toBe(0);

    const [events3, state3] = parseInputSequence(state2, "\x1b[201~");
    expect(state3.mode).toBe("NORMAL");
    expect(events3.length).toBe(1);
    expect(events3[0]!.kind).toBe("key");
    expect((events3[0] as any).isPasted).toBe(true);
    expect((events3[0] as any).sequence).toBe("hello world");
  });

  test("incomplete paste bracket flush clears paste mode", () => {
    const [events1, state1] = parseInputSequence(INITIAL_PARSER_STATE, "\x1b[200~");
    expect(state1.mode).toBe("IN_PASTE");

    const [events2, state2] = parseInputSequence(state1, "partial paste content");
    expect(state2.mode).toBe("IN_PASTE");

    const [events3, state3] = parseInputSequence(state2, null);
    expect(state3.mode).toBe("NORMAL");
    expect(state3.pasteBuffer).toBe("");
    expect(events3.length).toBe(1);
    expect(events3[0]!.kind).toBe("key");
    expect((events3[0] as any).isPasted).toBe(true);
    expect((events3[0] as any).sequence).toBe("partial paste content");
  });

  test("flush with empty paste buffer clears paste mode", () => {
    const [events1, state1] = parseInputSequence(INITIAL_PARSER_STATE, "\x1b[200~");
    expect(state1.mode).toBe("IN_PASTE");

    const [events2, state2] = parseInputSequence(state1, null);
    expect(state2.mode).toBe("NORMAL");
    expect(state2.pasteBuffer).toBe("");
    expect(events2.length).toBe(0);
  });

  test("split paste bracket sequence is parsed correctly", () => {
    const [events1, state1] = parseInputSequence(INITIAL_PARSER_STATE, "\x1b[200");
    expect(state1.mode).toBe("NORMAL");
    expect(state1.incomplete).toBe("\x1b[200");
    expect(events1.length).toBe(0);

    const [events2, state2] = parseInputSequence(state1, "~");
    expect(state2.mode).toBe("IN_PASTE");
    expect(state2.incomplete).toBe("");
    expect(events2.length).toBe(0);

    const [events3, state3] = parseInputSequence(state2, "hello");
    expect(state3.mode).toBe("IN_PASTE");
    expect(state3.pasteBuffer).toBe("hello");

    const [events4, state4] = parseInputSequence(state3, "\x1b[201");
    expect(state4.mode).toBe("IN_PASTE");
    expect(state4.incomplete).toBe("\x1b[201");

    const [events5, state5] = parseInputSequence(state4, "~");
    expect(state5.mode).toBe("NORMAL");
    expect(state5.incomplete).toBe("");
    expect(events5.length).toBe(1);
    expect(events5[0]!.kind).toBe("key");
    expect((events5[0] as any).isPasted).toBe(true);
    expect((events5[0] as any).sequence).toBe("hello");
  });
});

describe("parse-keypress batched control runs", () => {
  test("a run of backspaces yields one backspace event per byte", () => {
    const [events] = parseInputSequence(INITIAL_PARSER_STATE, "\x7f\x7f\x7f");
    expect(events.length).toBe(3);
    for (const event of events) {
      expect((event as any).name).toBe("backspace");
    }
  });

  test("printable text batched with a trailing backspace splits cleanly", () => {
    const [events] = parseInputSequence(INITIAL_PARSER_STATE, "abc\x7f");
    expect(events.length).toBe(2);
    expect((events[0] as any).sequence).toBe("abc");
    expect((events[1] as any).name).toBe("backspace");
  });

  test("pure printable batch stays a single event", () => {
    const [events] = parseInputSequence(INITIAL_PARSER_STATE, "abcdef");
    expect(events.length).toBe(1);
    expect((events[0] as any).sequence).toBe("abcdef");
  });

  test("paste content is never split by control bytes", () => {
    const [, s1] = parseInputSequence(INITIAL_PARSER_STATE, "\x1b[200~");
    const [, s2] = parseInputSequence(s1, "a\x7fb");
    const [events] = parseInputSequence(s2, "\x1b[201~");
    expect(events.length).toBe(1);
    expect((events[0] as any).sequence).toBe("a\x7fb");
  });
});

describe("App input timeout and paste lag guard", () => {
  test("resolvePasteTimeout and resolveIncompleteSequence drain buffer and do not hang", () => {
    let readCalls = 0;
    const mockStdin = {
      readableLength: 10,
      read() {
        readCalls++;
        if (readCalls === 1) {
          this.readableLength = 0;
          return "chunk1";
        }
        this.readableLength = 0;
        return null;
      },
      addListener: () => {},
      removeListener: () => {},
      setEncoding: () => {},
      ref: () => {},
      unref: () => {},
      setRawMode: () => {},
    } as any;

    const mockStdout = {
      write: () => true,
    } as any;

    const mockOnExit = () => {};

    const app = new App({
      children: null,
      stdin: mockStdin,
      stdout: mockStdout,
      stderr: mockStdout,
      exitOnCtrlC: false,
      onExit: mockOnExit,
      terminalColumns: 80,
      terminalRows: 24,
    });

    app.keyParseState = {
      mode: "IN_PASTE",
      incomplete: "some-incomplete",
      pasteBuffer: "some-paste",
    };

    app.resolvePasteTimeout();

    expect(readCalls).toBeGreaterThan(0);
    expect(mockStdin.readableLength).toBe(0);
  });

  test("resolvePasteTimeout handles empty read and does not loop forever", () => {
    const mockStdin = {
      readableLength: 10,
      read: () => null,
      addListener: () => {},
      removeListener: () => {},
      setEncoding: () => {},
      ref: () => {},
      unref: () => {},
      setRawMode: () => {},
    } as any;

    const mockStdout = {
      write: () => true,
    } as any;

    const mockOnExit = () => {};

    const app = new App({
      children: null,
      stdin: mockStdin,
      stdout: mockStdout,
      stderr: mockStdout,
      exitOnCtrlC: false,
      onExit: mockOnExit,
      terminalColumns: 80,
      terminalRows: 24,
    });

    app.keyParseState = {
      mode: "IN_PASTE",
      incomplete: "some-incomplete",
      pasteBuffer: "some-paste",
    };

    app.resolvePasteTimeout();
    expect(app.pasteTimeoutRearmCount).toBe(1);
    expect(app.pasteTimeoutTimer).not.toBeNull();

    app.resolvePasteTimeout();
    expect(app.pasteTimeoutRearmCount).toBe(2);
    expect(app.pasteTimeoutTimer).not.toBeNull();

    app.resolvePasteTimeout();
    expect(app.pasteTimeoutRearmCount).toBe(3);
    expect(app.pasteTimeoutTimer).not.toBeNull();

    app.resolvePasteTimeout();
    expect(app.pasteTimeoutRearmCount).toBe(0);
    expect(app.pasteTimeoutTimer).toBeNull();
  });
});
