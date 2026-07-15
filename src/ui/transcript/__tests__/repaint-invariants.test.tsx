import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Box, Text } from "@/ink";
import { transcriptActions } from "@/store/index.ts";
import Ink from "@/terminal-runtime/host/runtime-session.tsx";
import { Log } from "../blocks/log.tsx";
import type { TranscriptEntry } from "../types";
import { TerminalEmulator } from "./terminal-emulator.ts";

const FOOTER = "FOOTER_MARKER shift+tab";
const MASCOT = "MASCOT_ART_LINE";

type RenderOpts = { intro?: boolean; panel?: number; footer?: boolean; log?: boolean };

type Harness = {
  ink: Ink;
  term: TerminalEmulator;
  render: (entries: readonly TranscriptEntry[], opts?: RenderOpts) => void;
  resize: (w: number, h: number) => void;
  cleanup: () => void;
};

function createStdout(term: TerminalEmulator): NodeJS.WriteStream {
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
      term.write(String(chunk));
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
    emitResize() {
      for (const cb of listeners.get("resize") ?? []) cb();
    },
  };
  return stream as unknown as NodeJS.WriteStream;
}

function createStdin(): NodeJS.ReadStream {
  const s = {
    isTTY: false,
    isRaw: false,
    setRawMode() {},
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

function createHarness(width: number, height: number): Harness {
  const term = new TerminalEmulator(width, height);
  const stdout = createStdout(term);
  const ink = new Ink({
    stdout,
    stdin: createStdin(),
    stderr: createStdout(new TerminalEmulator(width, height)),
    exitOnCtrlC: true,
    patchConsole: false,
  });

  const render: Harness["render"] = (entries, opts = {}) => {
    const { intro = true, panel = 0, footer = true, log = true } = opts;
    ink.render(
      <Box flexDirection="column" width="100%">
        {log && (
          <Log
            entries={entries}
            intro={
              intro ? (
                <Box flexDirection="column">
                  <Text>{MASCOT} 1</Text>
                  <Text>{MASCOT} 2</Text>
                  <Text>{MASCOT} 3</Text>
                  <Text>{MASCOT} 4</Text>
                  <Text>{MASCOT} 5</Text>
                </Box>
              ) : null
            }
            providerShortKey="test"
            currentModel="model"
          />
        )}
        {panel > 0 && (
          <Box flexDirection="column" flexShrink={0}>
            {Array.from({ length: panel }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: synthetic static rows, never reorder
              <Text key={`p${i}`}>{`PANEL_ROW_${i}`}</Text>
            ))}
          </Box>
        )}
        {footer && (
          <Box flexDirection="column" flexShrink={0}>
            <Text>{FOOTER}</Text>
          </Box>
        )}
      </Box>,
    );
    ink.onRender();
  };

  return {
    ink,
    term,
    render,
    resize(w, h) {
      term.resize(w, h);
      (stdout as unknown as { emitResize: () => void }).emitResize();
      ink.onRender();
    },
    cleanup() {
      (stdout as unknown as { isTTY: boolean }).isTTY = false;
      ink.unmount(null);
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function entry(id: string, kind: TranscriptEntry["kind"], text: string): TranscriptEntry {
  return { id, kind, text };
}

function turns(count: number): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (let i = 0; i < count; i++) {
    // "x" terminator keeps each marker collision-free ("number 1" would
    // otherwise substring-match "number 10".."19").
    out.push(entry(`u${i}`, "user", `user message number ${i}x`));
    out.push(entry(`a${i}`, "assistant", `assistant reply number ${i}x`));
  }
  return out;
}

/**
 * Core invariants after any interaction sequence:
 * footer on the visible screen, and every marker present EXACTLY once across
 * scrollback+screen — "at least once" catches wipes, "at most once" catches
 * duplication. Content survival is the invariant the live wipes violated
 * while a footer-only harness stayed green.
 */
function expectStableSurface(term: TerminalEmulator, uniqueMarkers: string[]): void {
  expect(term.visibleRowOf(FOOTER)).toBeGreaterThanOrEqual(0);
  for (const marker of uniqueMarkers) {
    expect({ marker, count: term.countOccurrences(marker) }).toEqual({ marker, count: 1 });
  }
}

function allMarkers(count: number): string[] {
  const out: string[] = [`${MASCOT} 1`, `${MASCOT} 5`];
  for (let i = 0; i < count; i++) {
    out.push(`user message number ${i}x`, `assistant reply number ${i}x`);
  }
  return out;
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

describe("repaint invariants (simulated terminal)", () => {
  it("keeps every row exactly once through a streamed conversation", async () => {
    const h = createHarness(110, 45);
    try {
      h.render([]);
      await settle();
      // Simulated streaming: entries settle one by one, footer re-renders each time.
      const all = turns(4);
      for (let n = 1; n <= all.length; n++) {
        h.render(all.slice(0, n));
        await settle();
      }
      expectStableSurface(h.term, allMarkers(4));
      const mascotAt = h.term.allText().indexOf(`${MASCOT} 1`);
      const firstEcho = h.term.allText().indexOf("user message number 0x");
      expect(mascotAt).toBeGreaterThanOrEqual(0);
      expect(mascotAt).toBeLessThan(firstEcho);
    } finally {
      h.cleanup();
    }
  });

  it("keeps a SHORT conversation intact through height shrink and regrow", async () => {
    // The live wipe case: content fits the viewport (nothing has physically
    // scrolled), then the window shrinks. Every earlier row must survive.
    const h = createHarness(110, 45);
    try {
      h.render([]);
      await settle();
      const all = turns(2);
      for (let n = 1; n <= all.length; n++) {
        h.render(all.slice(0, n));
        await settle();
      }
      expectStableSurface(h.term, allMarkers(2));

      h.resize(110, 30);
      h.render(all);
      await settle();
      expectStableSurface(h.term, allMarkers(2));

      h.resize(110, 45);
      h.render(all);
      await settle();
      expectStableSurface(h.term, allMarkers(2));
    } finally {
      h.cleanup();
    }
  });

  it("keeps a TALL conversation's tail intact through height shrink", async () => {
    const h = createHarness(110, 45);
    try {
      h.render([]);
      await settle();
      const all = turns(30);
      for (let n = 2; n <= all.length; n += 2) {
        h.render(all.slice(0, n));
        await settle();
      }
      expectStableSurface(h.term, allMarkers(30));

      h.resize(110, 24);
      h.render(all);
      await settle();
      expectStableSurface(h.term, allMarkers(30));
    } finally {
      h.cleanup();
    }
  });

  it("recovers when resize is observed during layout", async () => {
    const h = createHarness(110, 45);
    try {
      h.render([]);
      await settle();
      const all = turns(4);
      for (let n = 1; n <= all.length; n++) {
        h.render(all.slice(0, n));
        await settle();
      }
      expectStableSurface(h.term, allMarkers(4));

      h.term.resize(110, 24);
      h.render(all);
      await settle();
      expectStableSurface(h.term, allMarkers(4));

      h.term.resize(110, 45);
      h.render(all);
      await settle();
      expectStableSurface(h.term, allMarkers(4));
    } finally {
      h.cleanup();
    }
  });

  it("keeps every row present through a width shrink", async () => {
    // The emulator does not reflow (tmux semantics); rows the app repaints
    // re-wrap while rows already in emulator scrollback keep the old width.
    // Survival (>= 1) is the invariant; historical residue is real-terminal
    // behavior, so exact-once is not asserted here.
    const h = createHarness(110, 45);
    try {
      h.render([]);
      await settle();
      const all = turns(2);
      for (let n = 1; n <= all.length; n++) {
        h.render(all.slice(0, n));
        await settle();
      }
      h.resize(80, 45);
      h.render(all);
      await settle();
      expect(h.term.visibleRowOf(FOOTER)).toBeGreaterThanOrEqual(0);
      for (const marker of allMarkers(2)) {
        expect({ marker, present: h.term.countOccurrences(marker) >= 1 }).toEqual({
          marker,
          present: true,
        });
      }
    } finally {
      h.cleanup();
    }
  });

  it("keeps a short conversation intact through a displacing panel cycle", async () => {
    // Owner's /model case: mascot + one turn on screen, panel opens and
    // closes. Everything above the panel must survive the cycle.
    const h = createHarness(110, 45);
    try {
      h.render([]);
      await settle();
      const all = turns(1);
      for (let n = 1; n <= all.length; n++) {
        h.render(all.slice(0, n));
        await settle();
      }
      h.render(all, { panel: 14, footer: false });
      await settle();
      h.render(all, { panel: 0, footer: true });
      await settle();
      expectStableSurface(h.term, allMarkers(1));
    } finally {
      h.cleanup();
    }
  });

  it("keeps a tall conversation intact through a displacing panel cycle after resize", async () => {
    const h = createHarness(110, 45);
    try {
      h.render([]);
      await settle();
      const all = turns(12);
      for (let n = 2; n <= all.length; n += 2) {
        h.render(all.slice(0, n));
        await settle();
      }
      h.resize(110, 42);
      h.render(all);
      await settle();
      h.render(all, { panel: 14, footer: false });
      await settle();
      h.render(all, { panel: 0, footer: true });
      await settle();
      // The shrink reset repaints rows re-entering the viewport; their
      // pre-close copies may remain in physical scrollback (inline rendering,
      // same contract as the multi-commit close). Survival everywhere,
      // exact-once in the visible viewport.
      expect(h.term.visibleRowOf(FOOTER)).toBeGreaterThanOrEqual(0);
      for (const marker of allMarkers(12)) {
        expect({ marker, present: h.term.countOccurrences(marker) >= 1 }).toEqual({
          marker,
          present: true,
        });
      }
      for (const marker of ["user message number 11x", "assistant reply number 11x"]) {
        expect({ marker, count: h.term.visibleText().split(marker).length - 1 }).toEqual({
          marker,
          count: 1,
        });
      }
    } finally {
      h.cleanup();
    }
  });

  it("keeps prompt and footer through a multi-commit displacing panel close", async () => {
    // The live /model case: a SHORT conversation (frame < viewport) whose
    // panel push crosses the frame PAST the viewport boundary (52 > 45 live),
    // and the close cascades through an intermediate commit that still lacks
    // the footer (prompt unlock and focus handoff land one commit later).
    // The close consumes a shrink->below reset on the footer-less frame; the
    // settled commit must still repaint the footer.
    const h = createHarness(110, 45);
    try {
      h.render([]);
      await settle();
      const all = turns(1);
      for (let n = 1; n <= all.length; n++) {
        h.render(all.slice(0, n));
        await settle();
      }
      h.render(all, { panel: 40, footer: false });
      await settle();
      // Close cascade: first commit drops the panel but has no footer yet,
      // the settled commit re-adds it.
      h.render(all, { panel: 0, footer: false });
      await settle();
      // The generic displacing-overlay close resync remounts Log/SelectionBarrier.
      // Model the epoch reset by invalidating the physical frame before the
      // final prompt/footer commit.
      h.ink.invalidatePrevFrame();
      h.render(all, { panel: 0, footer: true });
      await settle();
      // Inline remount may leave the pre-panel copy in physical scrollback;
      // visible state must be clean and complete (live contract).
      expect(h.term.visibleRowOf(FOOTER)).toBeGreaterThanOrEqual(0);
      for (const marker of allMarkers(1)) {
        expect({ marker, count: h.term.visibleText().split(marker).length - 1 }).toEqual({
          marker,
          count: 1,
        });
      }
    } finally {
      h.cleanup();
    }
  });

  it("keeps the compact panel and transcript through a displacing→compact panel swap", async () => {
    // The /model → login case ("Change config"): a displacing panel that
    // pushed the frame past the viewport is replaced by a compact panel in
    // the same commit chain — the overlay stack never empties. The swap
    // resync (displacingOverlayClosed on displacing→compact) remounts the
    // log, modeled here by invalidating the physical frame before the
    // compact-panel commit.
    const h = createHarness(110, 45);
    try {
      h.render([]);
      await settle();
      const all = turns(1);
      for (let n = 1; n <= all.length; n++) {
        h.render(all.slice(0, n));
        await settle();
      }
      h.render(all, { panel: 40, footer: false });
      await settle();
      h.ink.invalidatePrevFrame();
      h.render(all, { panel: 4, footer: true });
      await settle();
      expect(h.term.visibleRowOf(FOOTER)).toBeGreaterThanOrEqual(0);
      expect(h.term.visibleText()).toContain("PANEL_ROW_3");
      for (const marker of allMarkers(1)) {
        expect({ marker, count: h.term.visibleText().split(marker).length - 1 }).toEqual({
          marker,
          count: 1,
        });
      }
    } finally {
      h.cleanup();
    }
  });

  it("repaints scrollback rows that re-enter the viewport when a tall panel closes", async () => {
    // The /help //config case. Geometry is load-bearing: the frame prefix
    // (banner/transcript) is IDENTICAL across the close and the panel's rows
    // start exactly at the scrollback boundary, so neither the scrollback-diff
    // nor the above-viewport check fires — only the shrink guard can route to
    // the clamped reset. The post-close frame is STILL taller than the
    // viewport; prefix rows that re-enter the viewport live in physical
    // scrollback and the incremental path can never repaint them, leaving a
    // blank band until an external invalidation (resize). No
    // invalidatePrevFrame here: the renderer must recover on its own.
    const h = createHarness(110, 20);
    try {
      h.render([]);
      await settle();
      const all = turns(5);
      for (let n = 1; n <= all.length; n++) {
        h.render(all.slice(0, n));
        await settle();
      }
      h.render(all, { panel: 15, footer: false });
      await settle();
      h.render(all, { panel: 0, footer: true });
      await settle();
      expect(h.term.visibleRowOf(FOOTER)).toBeGreaterThanOrEqual(0);
      // These markers sat ABOVE the pre-close viewport (physically in
      // scrollback) and re-enter the viewport when the panel's rows leave the
      // frame: they must be VISIBLE, not merely present in scrollback. Markers
      // that were already inside the pre-close viewport survive either way and
      // prove nothing.
      for (const marker of ["user message number 2x", "assistant reply number 2x"]) {
        expect({ marker, count: h.term.visibleText().split(marker).length - 1 }).toEqual({
          marker,
          count: 1,
        });
      }
    } finally {
      h.cleanup();
    }
  });

  it("restores a clean tail after a fullscreen surface swap", async () => {
    // Workflows view: the log STAYS mounted while a viewport-sized panel
    // renders below it (the real tree shape), pushing the transcript out of
    // the viewport — correct by design. Closing must restore the transcript
    // tail with zero panel residue in the viewport; the push into scrollback
    // is inherent to inline rendering (no alt screen) and not asserted away.
    const h = createHarness(110, 45);
    try {
      h.render([]);
      await settle();
      const all = turns(10);
      for (let n = 2; n <= all.length; n += 2) {
        h.render(all.slice(0, n));
        await settle();
      }
      h.render(all, { panel: 45, footer: false });
      await settle();
      expect(h.term.visibleText()).toContain("PANEL_ROW_44");
      h.render(all, { panel: 0, footer: true });
      await settle();
      expect(h.term.visibleRowOf(FOOTER)).toBeGreaterThanOrEqual(0);
      expect(h.term.visibleText()).not.toContain("PANEL_ROW");
      // The visible tail is the end of the conversation, each row exactly once.
      for (const marker of ["user message number 9x", "assistant reply number 9x"]) {
        expect({ marker, count: h.term.visibleText().split(marker).length - 1 }).toEqual({
          marker,
          count: 1,
        });
      }
    } finally {
      h.cleanup();
    }
  });

  it("keeps settled rows intact when a panel opens during streaming", async () => {
    const h = createHarness(110, 45);
    try {
      h.render([]);
      await settle();
      const all = turns(3);
      for (let n = 1; n <= all.length; n++) {
        h.render(all.slice(0, n));
        await settle();
      }
      // A live streaming row keeps re-rendering below the settled rows while
      // the panel opens and closes mid-stream.
      const streaming: TranscriptEntry = {
        id: "t_stream",
        kind: "assistant",
        text: "streaming chunk one",
        streaming: true,
      };
      h.render([...all, streaming]);
      await settle();
      h.render([...all, { ...streaming, text: "streaming chunk one two" }], {
        panel: 14,
        footer: false,
      });
      await settle();
      h.render([...all, { ...streaming, text: "streaming chunk one two three" }], {
        panel: 0,
        footer: true,
      });
      await settle();
      const settledDone = [...all, entry("a_stream", "assistant", "streaming chunk one two three")];
      h.render(settledDone);
      await settle();
      expectStableSurface(h.term, [...allMarkers(3), "streaming chunk one two three"]);
    } finally {
      h.cleanup();
    }
  });
});
