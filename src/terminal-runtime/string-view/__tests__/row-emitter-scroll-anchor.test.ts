import { describe, expect, it } from "bun:test";
import { ModelTerminal } from "@/terminal-runtime/string-view/__tests__/model-terminal.ts";
import { InlineRowPainter } from "@/terminal-runtime/string-view/row-emitter.js";
import { ERASE_SCREEN, ERASE_SCROLLBACK } from "@/terminal-runtime/terminal/control-sequences.js";

const WIDTH = 40;

/**
 * Drives the emitter exactly the way the host does — boot, settle, live frame — while
 * keeping the logical document the screen should be showing: `shell + settled + frame`,
 * minus the rows scrolling has taken away for good. Whatever the inline start offset and
 * however far the document outgrows the viewport, the screen must equal that.
 */
class HostDriver {
  private readonly emitter = new InlineRowPainter();
  private readonly terminal: ModelTerminal;
  private readonly document: string[];
  private frame: readonly string[] = [];
  private scrolledRows = 0;
  private bytes = "";

  private readonly shellRowCount: number;

  constructor(
    private readonly height: number,
    shell: readonly string[] = [],
  ) {
    this.terminal = new ModelTerminal(height, shell.length, shell);
    this.document = [...shell];
    this.shellRowCount = shell.length;
  }

  boot(settled: readonly string[], frame: readonly string[]): void {
    this.document.push(...settled);
    this.paint(frame, this.emitter.paintScrollback(settled, frame, this.geometry()).bytes);
  }

  /**
   * Re-lay-out the settled document, the way the host does when an entry changed
   * without being a pure append — a tool result growing in place while it streams.
   */
  rebuild(settled: readonly string[], frame: readonly string[]): void {
    this.document.length = this.shellRowCount;
    this.document.push(...settled);
    this.paint(frame, this.emitter.paintScrollback(settled, frame, this.geometry()).bytes);
  }

  settle(appended: readonly string[], frame: readonly string[]): void {
    this.document.push(...appended);
    this.paint(frame, this.emitter.commitScrollback(appended, frame, this.geometry()).bytes);
  }

  live(frame: readonly string[]): void {
    this.paint(frame, this.emitter.emitFrame(frame, this.geometry()).bytes);
  }

  screen(): string[] {
    return this.terminal.visible();
  }

  /** Bytes the last paint emitted, so a test can assert what was NOT sent. */
  lastBytes(): string {
    return this.bytes;
  }

  expected(): string[] {
    const visible = [...this.document, ...this.frame].slice(this.scrolledRows);
    const padding = Array.from({ length: Math.max(0, this.height - visible.length) }, () => "");
    return [...visible, ...padding].map((line) => line.replace(/\s+$/u, ""));
  }

  private geometry(): { width: number; height: number } {
    return { width: WIDTH, height: this.height };
  }

  // A taller document scrolls its head away for good: a later, shorter frame cannot pull
  // those rows back, so the expectation carries the deepest scroll reached so far.
  private paint(frame: readonly string[], bytes: string): void {
    this.frame = frame;
    this.bytes = bytes;
    this.scrolledRows = Math.max(
      this.scrolledRows,
      this.document.length + frame.length - this.height,
    );
    if (bytes.length > 0) this.terminal.feed(bytes);
  }
}

const PROMPT_FRAME = ["", "> prompt", "status", "mode", ""];
const THINKING_FRAME = ["", "* Thinking…", "", "> prompt", "status", "mode", ""];
// Compacting opens a leading blank and a progress bar under the verb, so the live
// frame gains two rows in its middle while the chrome below keeps its text.
const COMPACTING_FRAME = [
  "",
  "* Compacting conversation…",
  "  ▰▰▰▱▱▱ 42%",
  "",
  "> prompt",
  "status",
  "mode",
  "",
];

// A turn at full height: streaming text, a progress line and a task list under it.
const STREAMING_FRAME = [
  "",
  "* Thinking…",
  "  └ ◻ read the emitter",
  "  ◻ characterize the shrink",
  "  ◻ write the test",
  "",
  ...Array.from({ length: 8 }, (_, index) => `streamed line ${index}`),
  "",
  "> prompt",
  "status",
  "mode",
  "",
];

function shellRows(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `shell-${index}`);
}

/** A turn whose streaming tool output has outgrown the screen it renders on. */
function oversizedFrame(streamedRows: number): string[] {
  return [
    "",
    "* Running…",
    ...Array.from({ length: streamedRows }, (_, index) => `live ${index}`),
    ...PROMPT_FRAME,
  ];
}

describe("InlineRowPainter scroll anchor", () => {
  it("keeps the tail correct while settled rows push the document past the viewport", () => {
    const driver = new HostDriver(12, shellRows(3));
    driver.boot(["welcome"], PROMPT_FRAME);

    for (let turn = 0; turn < 6; turn++) {
      driver.settle(["", `${turn} user asks`], PROMPT_FRAME);
      driver.live(THINKING_FRAME);
      driver.settle(["", `${turn} answer`], PROMPT_FRAME);
      expect(driver.screen()).toEqual(driver.expected());
    }
  });

  it("keeps the trailing rows stable when a live frame alternates height", () => {
    const driver = new HostDriver(12, shellRows(3));
    driver.boot(["welcome"], PROMPT_FRAME);
    driver.settle(["", "tool ran"], PROMPT_FRAME);

    for (let tick = 0; tick < 4; tick++) {
      driver.live(THINKING_FRAME);
      expect(driver.screen()).toEqual(driver.expected());
      driver.live(PROMPT_FRAME);
      expect(driver.screen()).toEqual(driver.expected());
    }
  });

  it("paints one compact progress bar however often the live frame ticks", () => {
    const driver = new HostDriver(14, shellRows(5));
    driver.boot(["welcome"], PROMPT_FRAME);
    driver.settle(["", "a long turn"], PROMPT_FRAME);
    driver.live(THINKING_FRAME);

    for (let tick = 0; tick < 6; tick++) {
      driver.live(COMPACTING_FRAME);
      expect(driver.screen().filter((row) => row.includes("%"))).toHaveLength(1);
      expect(driver.screen()).toEqual(driver.expected());
    }

    driver.settle(["", "⏺ Conversation compacted (3s)"], PROMPT_FRAME);
    expect(driver.screen()).toEqual(driver.expected());
    expect(driver.screen().filter((row) => row.includes("%"))).toHaveLength(0);
  });

  /**
   * An interrupt drops a full-height live block in one step. The rows it occupied are
   * erased in place — an inline surface cannot pull scrollback back down — so blank
   * rows stand below the prompt until output fills them again. What must hold is that
   * nothing of the dropped block survives and the document keeps its order, so the
   * next settle lands under the interruption rather than over it.
   */
  it("drops a collapsed turn cleanly and keeps the next settle in order", () => {
    for (const height of [14, 20, 26]) {
      const driver = new HostDriver(height, shellRows(4));
      driver.boot(["welcome"], PROMPT_FRAME);
      driver.settle(["", "❯ do the long thing"], PROMPT_FRAME);
      driver.live(STREAMING_FRAME);
      expect(driver.screen()).toEqual(driver.expected());

      driver.settle(["", "⎿ Interrupted by user"], PROMPT_FRAME);
      const collapsed = driver.screen();
      expect(collapsed.filter((row) => row.startsWith("streamed line"))).toEqual([]);
      expect(collapsed.indexOf("> prompt")).toBeGreaterThan(
        collapsed.indexOf("⎿ Interrupted by user"),
      );

      driver.settle(["", "next answer"], PROMPT_FRAME);
      const after = driver.screen();
      expect(after.indexOf("next answer")).toBeGreaterThan(after.indexOf("⎿ Interrupted by user"));
      expect(after.indexOf("> prompt")).toBeGreaterThan(after.indexOf("next answer"));
      expect(after.filter((row) => row === "⎿ Interrupted by user")).toHaveLength(1);
    }
  });

  /**
   * A tool that streams more rows than the viewport holds pushes the live frame past
   * the screen, so its head scrolls away and stops being addressable. Collapsing back
   * to the prompt must still be an ordinary paint: a destructive reset here would wipe
   * the scrollback the user is reading and throw their view to the top of it.
   */
  it("never wipes scrollback when an oversized live frame collapses", () => {
    for (const height of [14, 20, 30]) {
      const driver = new HostDriver(height, shellRows(3));
      driver.boot(["welcome"], PROMPT_FRAME);
      driver.settle(["", "❯ run the big command"], PROMPT_FRAME);

      for (let rows = 4; rows <= height * 2; rows += 5) {
        driver.live(oversizedFrame(rows));
        expect(driver.lastBytes()).not.toContain(ERASE_SCROLLBACK);
        expect(driver.lastBytes()).not.toContain(ERASE_SCREEN);
      }

      driver.settle(["", "⏺ Bash(big)", "  └ done"], PROMPT_FRAME);
      expect(driver.lastBytes()).not.toContain(ERASE_SCROLLBACK);
      expect(driver.lastBytes()).not.toContain(ERASE_SCREEN);

      // The collapsed block leaves no residue and the chrome lands under the result.
      const screen = driver.screen();
      expect(screen.filter((row) => row.startsWith("live "))).toEqual([]);
      expect(screen.indexOf("> prompt")).toBeGreaterThan(screen.indexOf("  └ done"));

      // And the surface keeps working: the next turn lands under what came before.
      driver.settle(["", "next answer"], PROMPT_FRAME);
      const after = driver.screen();
      expect(after.lastIndexOf("next answer")).toBeGreaterThan(after.indexOf("  └ done"));
      expect(after.indexOf("> prompt")).toBeGreaterThan(after.lastIndexOf("next answer"));
    }
  });

  /**
   * A footer overlay swells the live frame to the whole screen and closes again. The
   * rows its growth scrolled away are unreachable — an inline surface cannot pull
   * scrollback back down — so the shrunk frame re-anchors on the first visible row,
   * where its document position now is, and the rows it vacated are cleared in place.
   * Blanks standing below the prompt until content fills them are the same physics as
   * a collapsed live block; repainting the settled tail into the gap would duplicate
   * rows already committed to scrollback, and parking the frame at the screen bottom
   * would fabricate document rows that do not exist. Both stay forbidden.
   */
  it("re-anchors a closing full-screen overlay without erasing or duplicating anything", () => {
    for (const height of [12, 14, 20]) {
      const driver = new HostDriver(height, shellRows(3));
      driver.boot(["welcome"], PROMPT_FRAME);
      driver.settle(["", "❯ open the panel"], PROMPT_FRAME);

      const panelFrame = [
        "",
        ...Array.from({ length: height - 3 }, (_, index) => `panel row ${index}`),
        "> prompt",
        "",
      ];
      for (let cycle = 0; cycle < 3; cycle++) {
        driver.live(panelFrame);
        expect(driver.lastBytes()).not.toContain(ERASE_SCROLLBACK);
        expect(driver.lastBytes()).not.toContain(ERASE_SCREEN);
        expect(driver.screen()).toEqual(driver.expected());

        driver.live(PROMPT_FRAME);
        expect(driver.lastBytes()).not.toContain(ERASE_SCROLLBACK);
        expect(driver.lastBytes()).not.toContain(ERASE_SCREEN);
        // No overlay residue survives the close, and exactly one prompt remains.
        const closed = driver.screen();
        expect(closed.filter((row) => row.startsWith("panel row"))).toEqual([]);
        expect(closed.filter((row) => row === "> prompt")).toHaveLength(1);
        expect(closed).toEqual(driver.expected());
      }

      // The surface keeps working: the next settle lands under the reopened prompt.
      driver.settle(["", "next answer"], PROMPT_FRAME);
      const after = driver.screen();
      expect(after.lastIndexOf("next answer")).toBeLessThan(after.indexOf("> prompt"));
      expect(after).toEqual(driver.expected());
    }
  });

  /**
   * A foreground tool animates a spinner and an elapsed clock at the head of its live
   * frame. Once the streamed output pushes that head above the viewport the animation
   * is off screen, and writing for it would cost the user the scroll position they are
   * reading from, for something they cannot see. Output still on screen keeps painting.
   */
  it("costs nothing while a tool animates above the viewport, and still paints output", () => {
    const height = 14;
    const driver = new HostDriver(height, shellRows(3));
    driver.boot(["welcome"], PROMPT_FRAME);

    const ticking = (tick: number, streamed: number): string[] => [
      "",
      `${["◰", "◳", "◲", "◱"][tick % 4]} Running…`,
      `  └ Running… (${tick}s · timeout 2m)`,
      ...Array.from({ length: streamed }, (_, index) => `out ${index}`),
      ...PROMPT_FRAME,
    ];

    // Grow the turn until its animated head has scrolled off the top.
    for (let streamed = 1; streamed <= height * 2; streamed++) {
      driver.live(ticking(streamed, streamed));
      expect(driver.lastBytes()).not.toContain(ERASE_SCROLLBACK);
      expect(driver.lastBytes()).toContain("out ");
    }

    // From here the clock ticks alone, entirely above the viewport.
    const settled = driver.screen();
    for (let tick = 0; tick < 8; tick++) {
      driver.live(ticking(tick, height * 2));
      expect(driver.lastBytes()).toBe("");
    }
    expect(driver.screen()).toEqual(settled);
  });

  /**
   * A tool result grows in place while its command streams, so every update rewrites
   * the settled document rather than appending to it. Re-laying-out the same document
   * is an ordinary paint: only a different document taking over the screen may erase
   * what is there, because that erase costs the reader their scrollback.
   */
  it("re-lays-out a document that grew in place without erasing the screen", () => {
    for (const height of [14, 30]) {
      const driver = new HostDriver(height, shellRows(3));
      driver.boot(["welcome", "", "❯ run the loop"], PROMPT_FRAME);

      const settledThrough = (lines: number): string[] => [
        "welcome",
        "",
        "❯ run the loop",
        "⏺ Bash(for i in $(seq 1 40); do echo linha-$i; sleep 0.5; done)",
        ...Array.from({ length: lines }, (_, index) => `  └ linha-${index + 1}`),
      ];

      for (let lines = 1; lines <= 40; lines++) {
        driver.rebuild(settledThrough(lines), PROMPT_FRAME);
        expect(driver.lastBytes()).not.toContain(ERASE_SCROLLBACK);
        expect(driver.lastBytes()).not.toContain(ERASE_SCREEN);
      }

      // The tail is what the reader is looking at, and it has to be right.
      const screen = driver.screen();
      expect(screen).toContain("  └ linha-40");
      expect(screen.indexOf("> prompt")).toBeGreaterThan(screen.indexOf("  └ linha-40"));
    }
  });

  it("survives a long mixed sequence of settles and live frames at every shell offset", () => {
    const frames = [PROMPT_FRAME, THINKING_FRAME, COMPACTING_FRAME];
    for (let offset = 0; offset < 8; offset++) {
      const driver = new HostDriver(14, shellRows(offset));
      driver.boot(["welcome"], PROMPT_FRAME);
      let seed = 1;
      for (let step = 0; step < 40; step++) {
        // Deterministic walk over the frame shapes and settle sizes a turn produces.
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        const frame = frames[seed % frames.length] ?? PROMPT_FRAME;
        if (seed % 3 === 0) {
          const rows = Array.from({ length: 1 + (seed % 4) }, (_, row) => `s${step}-${row}`);
          driver.settle(["", ...rows], frame);
        } else {
          driver.live(frame);
        }
        expect(driver.screen()).toEqual(driver.expected());
      }
    }
  });
});
