import { afterEach, describe, expect, it } from "bun:test";
import { Box, Ink, Text } from "@/ink";
import { Prompt } from "@/ui/input/prompt.tsx";
import { promptWrapWalkCount } from "@/ui/input/prompt-text.ts";
import { TerminalEmulator } from "@/ui/transcript/__tests__/terminal-emulator.ts";

const SETTLED_ROW = "SETTLED_TRANSCRIPT_ROW";
const FOOTER_ROW = "FOOTER_STATUS_ROW";

type Harness = {
  ink: Ink;
  term: TerminalEmulator;
  bytesWritten: () => number;
  writtenSince: (mark: number) => string;
  render: (value: string) => void;
  cleanup: () => void;
};

function createStdout(term: TerminalEmulator, sink: { data: string }): NodeJS.WriteStream {
  const listeners = new Map<string, Set<() => void>>();
  const stream = {
    get columns() {
      return term.columns;
    },
    get rows() {
      return term.rows;
    },
    isTTY: true,
    write(chunk: unknown) {
      const text = String(chunk);
      sink.data += text;
      term.write(text);
      return true;
    },
    on(event: string, cb: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(cb);
      return stream;
    },
    off(event: string, cb: () => void) {
      listeners.get(event)?.delete(cb);
      return stream;
    },
  };
  return stream as unknown as NodeJS.WriteStream;
}

function createStdin(): NodeJS.ReadStream {
  const s = {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      s.isRaw = value;
      return s;
    },
    setEncoding() {
      return s;
    },
    ref() {
      return s;
    },
    unref() {
      return s;
    },
    read: () => null,
    listeners: () => [],
    addListener() {
      return s;
    },
    removeListener() {
      return s;
    },
    on() {
      return s;
    },
    off() {
      return s;
    },
  };
  return s as unknown as NodeJS.ReadStream;
}

function createHarness(width: number, height: number, transcriptRows: number): Harness {
  const term = new TerminalEmulator(width, height);
  const sink = { data: "" };
  const stdout = createStdout(term, sink);
  const ink = new Ink({
    stdout,
    stdin: createStdin(),
    stderr: createStdout(new TerminalEmulator(width, height), { data: "" }),
    exitOnCtrlC: true,
    patchConsole: false,
  });

  const render = (value: string): void => {
    ink.render(
      <Box flexDirection="column" width="100%">
        <Box flexDirection="column">
          {Array.from({ length: transcriptRows }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: settled synthetic rows, never reorder
            <Text key={`t${i}`}>{`${SETTLED_ROW}_${i} lorem ipsum dolor sit amet`}</Text>
          ))}
        </Box>
        <Prompt onSubmit={() => {}} value={value} onChange={() => {}} />
        <Text>{FOOTER_ROW}</Text>
      </Box>,
    );
    // The paint pass is normally throttled behind a microtask; run it
    // synchronously so each simulated keystroke produces exactly one flush.
    ink.onRender();
  };

  return {
    ink,
    term,
    bytesWritten: () => sink.data.length,
    writtenSince: (mark: number) => sink.data.slice(mark),
    render,
    cleanup: () => ink.unmount(),
  };
}

// ~9.5k chars: paragraphs with newlines plus one long unbroken token, kept
// under the 10k input-collapse threshold so the full text stays in the buffer.
function longText(): string {
  const paragraph =
    "The quick brown fox jumps over the lazy dog while the renderer keeps pace with every keystroke without repainting settled rows. ";
  const unbroken = "x".repeat(600);
  let out = "";
  while (out.length < 8800) {
    out += `${paragraph.repeat(3).trimEnd()}\n`;
  }
  return `${out}${unbroken}\n`;
}

let active: Harness | null = null;

afterEach(() => {
  active?.cleanup();
  active = null;
});

describe("prompt repaint discipline with long content", () => {
  it("keeps keystroke cost bounded: no transcript repaint, few wrap walks", () => {
    const harness = createHarness(100, 30, 40);
    active = harness;
    const base = longText();

    harness.render(base);
    // Warm-up keystroke: absorbs first-render layout settling.
    harness.render(`${base}a`);

    const typed = "typing at the end";
    const perKeyWalks: number[] = [];
    const perKeyMs: number[] = [];
    const perKeyBytes: number[] = [];
    let transcriptRepainted = false;

    for (let i = 0; i < typed.length; i++) {
      const value = `${base}a${typed.slice(0, i + 1)}`;
      const walksBefore = promptWrapWalkCount();
      const bytesBefore = harness.bytesWritten();
      const t0 = performance.now();
      harness.render(value);
      perKeyMs.push(performance.now() - t0);
      perKeyWalks.push(promptWrapWalkCount() - walksBefore);
      perKeyBytes.push(harness.bytesWritten() - bytesBefore);
      if (harness.writtenSince(bytesBefore).includes(SETTLED_ROW)) transcriptRepainted = true;
    }

    const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.info(
      `[prompt-repaint] ${base.length + 1} chars · per keystroke: ` +
        `wrapWalks avg=${avg(perKeyWalks).toFixed(1)} max=${Math.max(...perKeyWalks)} · ` +
        `render ms avg=${avg(perKeyMs).toFixed(2)} max=${Math.max(...perKeyMs).toFixed(2)} · ` +
        `bytes avg=${Math.round(avg(perKeyBytes))} max=${Math.max(...perKeyBytes)}`,
    );

    // Typing must not rewrite the settled transcript above the prompt.
    expect(transcriptRepainted).toBe(false);
    // One wrap walk per text change; cursor resolution and editing helpers
    // reuse the cached rows.
    expect(Math.max(...perKeyWalks)).toBeLessThanOrEqual(1);
  });

  // Regression guard: accented/emoji/CJK text used to defeat the ASCII
  // fast path of the width walk, costing ~200ms of re-measurement per
  // keystroke at this size. The bound is ~10x the fixed cost so it only
  // trips on a complexity regression, not on machine noise.
  it("keeps keystrokes cheap with non-ASCII content", () => {
    const harness = createHarness(100, 30, 10);
    active = harness;
    let base = "";
    while (base.length < 9000) base += "café naïve 汉字テスト 😀 pequeño jalapeño über ";

    harness.render(base);
    harness.render(`${base}a`);

    const perKeyMs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      harness.render(`${base}a${"more text!".slice(0, i + 1)}`);
      perKeyMs.push(performance.now() - t0);
    }
    perKeyMs.sort((a, b) => a - b);
    const median = perKeyMs[Math.floor(perKeyMs.length / 2)] ?? 0;
    console.info(
      `[prompt-repaint] non-ASCII ${base.length + 1} chars · median=${median.toFixed(2)}ms per keystroke`,
    );
    expect(median).toBeLessThan(50);
  });

  it("does not re-wrap on pure cursor-position renders", () => {
    const harness = createHarness(100, 30, 5);
    active = harness;
    const base = longText();
    harness.render(base);

    const walksBefore = promptWrapWalkCount();
    // Same text re-rendered (e.g. unrelated app state changed): the cached
    // wrap must be reused.
    harness.render(base);
    harness.render(base);
    expect(promptWrapWalkCount() - walksBefore).toBe(0);
  });

  it("re-wraps once when the width changes", () => {
    const harness = createHarness(100, 30, 5);
    active = harness;
    const base = longText();
    harness.render(base);

    const walksBefore = promptWrapWalkCount();
    harness.term.resize(80, 30);
    (harness.ink as unknown as { resized: () => void }).resized?.();
    harness.render(base);
    expect(promptWrapWalkCount() - walksBefore).toBeLessThanOrEqual(2);
  });
});
