import { describe, expect, it } from "bun:test";
import type { CodexSessionState } from "@/engine/providers/codex/transport/state.ts";
import { buildWsFrameRouter, type FrameRouterState } from "../ws-router.ts";

function makeHarness(): {
  state: FrameRouterState;
  flags: { sawTerminal: boolean; sawErrorTerminal: boolean; closed: boolean };
  feed: (frame: object) => void;
} {
  const flags = { sawTerminal: false, sawErrorTerminal: false, closed: false };
  const state: FrameRouterState = {
    queue: [],
    drain: () => {},
    setSawTerminal: (v) => {
      flags.sawTerminal = v;
    },
    setSawErrorTerminal: (v) => {
      flags.sawErrorTerminal = v;
    },
    setClosed: (v) => {
      flags.closed = v;
    },
    session: {} as CodexSessionState,
    prewarmIds: new Set(),
  };
  const handleFrame = buildWsFrameRouter(state);
  return { state, flags, feed: (frame) => handleFrame(Buffer.from(JSON.stringify(frame))) };
}

describe("ws frame router error-terminal flag", () => {
  it("marks error terminals so the socket is not reused by the next attempt", () => {
    for (const type of ["response.failed", "response.error", "error"]) {
      const { flags, feed } = makeHarness();
      feed({ type });
      expect(flags.sawTerminal).toBe(true);
      expect(flags.sawErrorTerminal).toBe(true);
      expect(flags.closed).toBe(true);
    }
  });

  it("keeps success/cancel terminals reusable", () => {
    for (const type of ["response.completed", "response.cancelled", "response.incomplete"]) {
      const { flags, feed } = makeHarness();
      feed({ type });
      expect(flags.sawTerminal).toBe(true);
      expect(flags.sawErrorTerminal).toBe(false);
    }
  });

  it("non-terminal frames touch neither flag", () => {
    const { flags, feed } = makeHarness();
    feed({ type: "response.output_text.delta", delta: "x" });
    expect(flags.sawTerminal).toBe(false);
    expect(flags.sawErrorTerminal).toBe(false);
  });
});
