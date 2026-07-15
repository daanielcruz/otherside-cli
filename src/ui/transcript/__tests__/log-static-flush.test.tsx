import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { transcriptActions } from "@/store/index.ts";
import Ink from "@/terminal-runtime/host/runtime-session.tsx";
import StaticFlushContext from "@/terminal-runtime/react/scrollback-context.js";
import { Log } from "../blocks/log.tsx";
import type { TranscriptEntry } from "../types";

type CaptureStream = NodeJS.WriteStream & {
  output: string;
  writes: string[];
  columns: number;
  rows: number;
  isTTY: boolean;
  clear: () => void;
};

function createCaptureStream({ isTTY = true, columns = 40, rows = 8 } = {}): CaptureStream {
  const stream = {
    output: "",
    writes: [] as string[],
    columns,
    rows,
    isTTY,
    write(chunk: unknown) {
      const text = String(chunk);
      this.output += text;
      this.writes.push(text);
      return true;
    },
    on() {
      return this;
    },
    off() {
      return this;
    },
    clear() {
      this.output = "";
      this.writes = [];
    },
  };
  return stream as unknown as CaptureStream;
}

function createInputStream(): NodeJS.ReadStream {
  return {
    isTTY: false,
    isRaw: false,
    setRawMode() {},
    listeners() {
      return [];
    },
    addListener() {
      return this;
    },
    removeListener() {
      return this;
    },
    on() {
      return this;
    },
    off() {
      return this;
    },
  } as unknown as NodeJS.ReadStream;
}

function createInkHarness() {
  const stdout = createCaptureStream();
  const ink = new Ink({
    stdout,
    stdin: createInputStream(),
    stderr: createCaptureStream({ isTTY: false }) as NodeJS.WriteStream,
    exitOnCtrlC: true,
    patchConsole: false,
  });

  return {
    ink,
    stdout,
    cleanup() {
      stdout.isTTY = false;
      ink.unmount(null);
    },
  };
}

async function drainScheduledRender(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// The frame paint interleaves cursor/style CSI with text (cursor-forward
// stands in for runs of spaces), so occurrence counting must run on the plain
// text the terminal would display.
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[(\d*)C/g, (_, count: string) => " ".repeat(Number(count || "1")))
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function countOccurrences(text: string, needle: string): number {
  return stripAnsi(text).split(needle).length - 1;
}

function renderLog(ink: Ink, entries: readonly TranscriptEntry[], remountKey = "log"): void {
  ink.render(
    <StaticFlushContext.Provider value={(node) => ink.enqueueStaticFlush(node)}>
      <Log
        key={remountKey}
        entries={entries}
        intro={null}
        providerShortKey="test"
        currentModel="model"
      />
    </StaticFlushContext.Provider>,
  );
  ink.onRender();
}

let previousNodeEnv: string | undefined;

beforeEach(() => {
  previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  transcriptActions.clear();
});
afterEach(() => {
  transcriptActions.clear();
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

describe("Log settled-row retention", () => {
  it("paints committed rows once and never rewrites them for pending updates or remounts", async () => {
    const { ink, stdout, cleanup } = createInkHarness();
    const committed: TranscriptEntry[] = [
      { id: "u1", kind: "user", text: "first committed" },
      { id: "a1", kind: "assistant", text: "second committed" },
    ];
    try {
      renderLog(ink, [...committed, { id: "t_pending", kind: "system", text: "pending one" }]);
      await drainScheduledRender();

      expect(countOccurrences(stdout.output, "first committed")).toBe(1);
      expect(countOccurrences(stdout.output, "second committed")).toBe(1);
      expect(stripAnsi(stdout.output)).toContain("pending one");

      stdout.clear();
      renderLog(ink, [...committed, { id: "t_pending", kind: "system", text: "pending two" }]);
      await drainScheduledRender();

      expect(stripAnsi(stdout.output)).not.toContain("first committed");
      expect(stripAnsi(stdout.output)).not.toContain("second committed");
      expect(stripAnsi(stdout.output)).toContain("two");

      stdout.clear();
      renderLog(
        ink,
        [...committed, { id: "t_pending", kind: "system", text: "pending three" }],
        "log-2",
      );
      await drainScheduledRender();

      expect(stripAnsi(stdout.output)).not.toContain("first committed");
      expect(stripAnsi(stdout.output)).not.toContain("second committed");
      // The differ reuses the shared "pending t" prefix and repaints the tail.
      expect(stripAnsi(stdout.output)).toContain("hree");
    } finally {
      cleanup();
    }
  });

  it("repaints settled rows still inside the viewport on a resize reset", async () => {
    const { ink, stdout, cleanup } = createInkHarness();
    const committed: TranscriptEntry[] = [
      { id: "u1", kind: "user", text: "first committed" },
      { id: "a1", kind: "assistant", text: "second committed" },
    ];
    const entries = [
      ...committed,
      { id: "t_pending", kind: "system", text: "pending one" } as const,
    ];
    try {
      renderLog(ink, entries);
      await drainScheduledRender();

      stdout.clear();
      stdout.columns = 36;
      renderLog(ink, entries);
      await drainScheduledRender();

      expect(countOccurrences(stdout.output, "first committed")).toBe(1);
      expect(countOccurrences(stdout.output, "second committed")).toBe(1);
      expect(stripAnsi(stdout.output)).toContain("pending one");
    } finally {
      cleanup();
    }
  });

  it("keeps rows already in scrollback out of the resize repaint", async () => {
    const { ink, stdout, cleanup } = createInkHarness();
    const committed: TranscriptEntry[] = Array.from({ length: 10 }, (_, i) => ({
      id: `u${i}`,
      kind: "user",
      text: `row number ${i} settled`,
    }));
    try {
      renderLog(ink, committed);
      await drainScheduledRender();

      stdout.clear();
      stdout.columns = 36;
      renderLog(ink, committed);
      await drainScheduledRender();

      const repaint = stripAnsi(stdout.output);
      // The tallest rows scrolled out long ago; the reset must not re-emit
      // them below the untouched scrollback copy.
      expect(repaint).not.toContain("row number 0 settled");
      expect(repaint).not.toContain("row number 1 settled");
      expect(repaint).toContain("row number 9 settled");
    } finally {
      cleanup();
    }
  });
});
