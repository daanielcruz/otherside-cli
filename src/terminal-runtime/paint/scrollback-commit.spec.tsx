import { describe, expect, it } from "bun:test";
import { useLayoutEffect, useRef } from "react";
import Ink from "@/terminal-runtime/host/runtime-session.js";
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  StylePool,
  setCellAt,
} from "@/terminal-runtime/paint/cell-grid.js";
import type { Diff, Frame } from "@/terminal-runtime/paint/frame-state.js";
import {
  serializeFrameLines,
  TerminalRenderBuffer,
} from "@/terminal-runtime/paint/output-journal.js";
import StyledText from "@/terminal-runtime/react/styled-text.js";
import { useScrollbackCommit } from "@/terminal-runtime/react/use-scrollback-commit.js";
import { eraseViewportInPlace } from "@/terminal-runtime/terminal/clear-screen.js";
import { HYPERLINK_END } from "@/terminal-runtime/terminal/operating-system-command.js";
import { BSU, ESU } from "@/terminal-runtime/terminal/private-modes.js";
import { flushDiffBuffer } from "@/terminal-runtime/terminal/runtime-channel.js";
import { optimize } from "@/terminal-runtime/tree/render-pruning.js";

type CaptureStream = NodeJS.WriteStream & {
  output: string;
  writes: string[];
  columns: number;
  rows: number;
  isTTY: boolean;
  clear: () => void;
};

function createCaptureStream({ isTTY = true, columns = 20, rows = 6 } = {}): CaptureStream {
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
  const previousAccessibility = process.env.OTHERSIDE_ACCESSIBILITY;
  process.env.OTHERSIDE_ACCESSIBILITY = "1";
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
      if (previousAccessibility === undefined) {
        delete process.env.OTHERSIDE_ACCESSIBILITY;
      } else {
        process.env.OTHERSIDE_ACCESSIBILITY = previousAccessibility;
      }
    },
  };
}

function HookFlusher({ labels }: { labels: string[] }) {
  const flush = useScrollbackCommit();
  const didFlush = useRef(false);
  useLayoutEffect(() => {
    if (didFlush.current) {
      return;
    }
    didFlush.current = true;
    for (const label of labels) {
      flush(<StyledText>{label}</StyledText>);
    }
  }, [flush, labels]);
  return <StyledText>live</StyledText>;
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function drainScheduledRender(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeFrame(
  lines: string[],
  {
    width = 12,
    viewportRows = 6,
    stylePool = new StylePool(),
  }: { width?: number; viewportRows?: number; stylePool?: StylePool } = {},
): { frame: Frame; stylePool: StylePool } {
  const charPool = new CharPool();
  const hyperlinkPool = new HyperlinkPool();
  const screen = createScreen(width, lines.length, stylePool, charPool, hyperlinkPool);
  for (let y = 0; y < lines.length; y++) {
    const line = lines[y]!;
    for (let x = 0; x < Math.min(width, line.length); x++) {
      setCellAt(screen, x, y, {
        char: line[x]!,
        styleId: stylePool.none,
        width: CellWidth.Narrow,
        hyperlink: undefined,
      });
    }
  }
  return {
    stylePool,
    frame: {
      screen,
      viewport: { width, height: viewportRows },
      cursor: { x: 0, y: lines.length, visible: true },
    },
  };
}

function diffText(diff: Diff): string {
  return diff.map((patch) => (patch.type === "stdout" ? patch.content : "")).join("");
}

describe("static flush", () => {
  it("flush writes each queued node exactly once across renders", async () => {
    const { ink, stdout, cleanup } = createInkHarness();
    try {
      ink.render(<HookFlusher labels={["first-static", "second-static"]} />);
      ink.onRender();
      await drainScheduledRender();

      expect(countOccurrences(stdout.output, "first-static")).toBe(1);
      expect(countOccurrences(stdout.output, "second-static")).toBe(1);
      expect(stdout.output.indexOf("first-static")).toBeLessThan(
        stdout.output.indexOf("second-static"),
      );

      stdout.clear();
      ink.render(<StyledText>live-2</StyledText>);
      ink.onRender();
      await drainScheduledRender();

      expect(stdout.output).not.toContain("first-static");
      expect(stdout.output).not.toContain("second-static");
    } finally {
      cleanup();
    }
  });

  it("exposes useStaticFlush through context", async () => {
    const { ink, stdout, cleanup } = createInkHarness();
    try {
      ink.render(<HookFlusher labels={["hook-static"]} />);
      ink.onRender();
      await drainScheduledRender();

      expect(countOccurrences(stdout.output, "hook-static")).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("writes erase, static lines, then live frame inside one synchronized block", () => {
    const { frame, stylePool } = makeFrame(["live-frame"], { viewportRows: 4 });
    const log = new TerminalRenderBuffer({ isTTY: true, stylePool });
    const diff = log.rebaseAfterStaticFlush(frame);
    diff.splice(1, 0, { type: "stdout", content: "static-a\nstatic-b\n" });

    const stdout = createCaptureStream();
    flushDiffBuffer(
      { stdout, stderr: createCaptureStream({ isTTY: false }) },
      optimize(diff),
      false,
      4,
    );

    const erase = eraseViewportInPlace(4);
    expect(stdout.output.startsWith(BSU + erase + "static-a\nstatic-b\n")).toBe(true);
    expect(stdout.output.indexOf("static-b\n")).toBeLessThan(stdout.output.indexOf("live-frame"));
    expect(stdout.output.endsWith(ESU)).toBe(true);
    expect(stdout.output.slice(BSU.length, -ESU.length)).not.toContain(BSU);
    expect(stdout.output.slice(BSU.length, -ESU.length)).not.toContain(ESU);
  });

  it("closes static style and hyperlink before the live frame", () => {
    const stylePool = new StylePool();
    const charPool = new CharPool();
    const hyperlinkPool = new HyperlinkPool();
    const screen = createScreen(4, 1, stylePool, charPool, hyperlinkPool);
    const redStyle = stylePool.intern([{ type: "ansi", code: "\x1b[31m", endCode: "\x1b[39m" }]);
    setCellAt(screen, 0, 0, {
      char: "S",
      styleId: redStyle,
      width: CellWidth.Narrow,
      hyperlink: "https://example.test/",
    });
    const staticFrame: Frame = {
      screen,
      viewport: { width: 4, height: 4 },
      cursor: { x: 0, y: 1, visible: true },
    };
    const staticText = `${serializeFrameLines(staticFrame, stylePool).join("\n")}\n`;
    const live = "live-frame";
    const stream = staticText + live;
    const liveIndex = stream.indexOf(live);

    expect(stream.indexOf(HYPERLINK_END)).toBeGreaterThan(stream.indexOf("S"));
    expect(stream.indexOf(HYPERLINK_END)).toBeLessThan(stream.indexOf("\n"));
    expect(stream.indexOf("\x1b[39m")).toBeGreaterThan(stream.indexOf("S"));
    expect(stream.indexOf("\x1b[39m")).toBeLessThan(stream.indexOf("\n"));
    expect(stream.lastIndexOf(HYPERLINK_END, liveIndex)).toBeGreaterThan(stream.indexOf("S"));
    expect(stream.lastIndexOf("\x1b[39m", liveIndex)).toBeGreaterThan(stream.indexOf("S"));
  });

  it("resize after flush rebases only the live frame", () => {
    const stylePool = new StylePool();
    const { frame } = makeFrame(["live-wide"], { width: 12, viewportRows: 4, stylePool });
    const resized = makeFrame(["live"], { width: 8, viewportRows: 4, stylePool }).frame;
    const log = new TerminalRenderBuffer({ isTTY: true, stylePool });

    log.rebaseAfterStaticFlush(frame);
    const resizeDiff = log.render(frame, resized);
    const clear = resizeDiff.find((patch) => patch.type === "clearTerminal");

    expect(clear).toMatchObject({ type: "clearTerminal", reason: "resize", viewportRows: 4 });
    expect(diffText(resizeDiff)).not.toContain("static");
  });

  it("scrollback guard full reset does not fire on a well-formed flush", () => {
    const stylePool = new StylePool();
    const prev = makeFrame(["old-a", "old-b", "old-c", "old-d"], {
      width: 12,
      viewportRows: 2,
      stylePool,
    }).frame;
    const next = makeFrame(["new-a", "old-b", "old-c", "old-d"], {
      width: 12,
      viewportRows: 2,
      stylePool,
    }).frame;

    const guardedLog = new TerminalRenderBuffer({ isTTY: true, stylePool });
    const guardedDiff = guardedLog.render(prev, next);
    expect(guardedDiff.find((patch) => patch.type === "clearTerminal")).toMatchObject({
      reason: "offscreen",
    });

    const flushLog = new TerminalRenderBuffer({ isTTY: true, stylePool });
    const flushDiff = flushLog.rebaseAfterStaticFlush(next);
    expect(flushDiff.find((patch) => patch.type === "clearTerminal")).toMatchObject({
      reason: "staticFlush",
    });
    expect(flushLog.render(next, next).some((patch) => patch.type === "clearTerminal")).toBe(false);
  });

  it("anchors a trailing shrink below the prompt instead of re-entering scrollback", () => {
    const stylePool = new StylePool();
    // Scrolled frame: log fills the scrollback, a prompt row, then a menu block
    // below it that collapses to a single footer row (slash menu closing).
    const openLines = [
      "log 0",
      "log 1",
      "log 2",
      "log 3",
      "log 4",
      "log 5",
      "log 6",
      "> prompt",
      "menu A",
      "menu B",
    ];
    const closedLines = [
      "log 0",
      "log 1",
      "log 2",
      "log 3",
      "log 4",
      "log 5",
      "log 6",
      "> prompt",
      "footer",
    ];
    const promptRowY = 7;
    const open = makeFrame(openLines, { width: 12, viewportRows: 6, stylePool }).frame;
    const closed = makeFrame(closedLines, { width: 12, viewportRows: 6, stylePool }).frame;

    // With the prompt caret declared above the collapse, the shrink is trailing:
    // it must stay on the incremental path (no clamped reset that would drag the
    // prompt/log back down).
    const anchored = new TerminalRenderBuffer({ isTTY: true, stylePool });
    expect(
      anchored.render(open, closed, promptRowY).some((patch) => patch.type === "clearTerminal"),
    ).toBe(false);

    // Without a declared caret (a displacing panel owns the surface), the same
    // shrink re-enters scrollback and must take the clamped reset.
    const reset = new TerminalRenderBuffer({ isTTY: true, stylePool });
    expect(
      reset.render(open, closed).find((patch) => patch.type === "clearTerminal"),
    ).toMatchObject({ reason: "offscreen" });
  });
});
