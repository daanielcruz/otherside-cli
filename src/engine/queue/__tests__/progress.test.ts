import { describe, expect, it } from "bun:test";
import { applyAgentEventToProgress, emptyProgressState } from "@/engine/queue/turn/progress.ts";

describe("applyAgentEventToProgress", () => {
  it("counts thinking_delta toward output like text_delta", () => {
    const afterThinking = applyAgentEventToProgress(emptyProgressState(), {
      kind: "thinking_delta",
      text: "reasoning...",
    });
    expect(afterThinking.responseChars).toBe("reasoning...".length);
  });

  it("accumulates thinking and text deltas together", () => {
    let state = emptyProgressState();
    state = applyAgentEventToProgress(state, { kind: "thinking_delta", text: "abc" });
    state = applyAgentEventToProgress(state, { kind: "text_delta", text: "de" });
    expect(state.responseChars).toBe(5);
  });

  it("ignores thinking_signature (no text to count)", () => {
    const state = applyAgentEventToProgress(emptyProgressState(), {
      kind: "thinking_signature",
      signature: "sig",
    });
    expect(state.responseChars).toBe(0);
  });
});
