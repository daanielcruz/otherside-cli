import { describe, expect, it } from "bun:test";
import { PromptUndoHistory } from "@/ui/input/prompt-undo.ts";

function historyWithClock(coalesceMs = 1_000): {
  history: PromptUndoHistory;
  advance: (ms: number) => void;
} {
  let clock = 10_000;
  const history = new PromptUndoHistory({ coalesceMs, now: () => clock });
  return {
    history,
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe("PromptUndoHistory", () => {
  it("folds a typing burst into one step and opens a new one after a pause", () => {
    const { history, advance } = historyWithClock();

    history.record({ text: "", caret: 0 });
    advance(100);
    history.record({ text: "a", caret: 1 });
    advance(100);
    history.record({ text: "ab", caret: 2 });
    expect(history.depth()).toBe(1);

    advance(1_500);
    history.record({ text: "abc", caret: 3 });
    expect(history.depth()).toBe(2);

    expect(history.undo()).toEqual({ text: "abc", caret: 3 });
    expect(history.undo()).toEqual({ text: "", caret: 0 });
    expect(history.undo()).toBeNull();
  });

  it("caps the stack and drops the oldest step first", () => {
    const { history, advance } = historyWithClock();
    for (let step = 0; step < 60; step++) {
      advance(2_000);
      history.record({ text: `step-${step}`, caret: step });
    }

    expect(history.depth()).toBe(50);
    expect(history.undo()).toEqual({ text: "step-59", caret: 59 });
  });

  it("starts a fresh step after an undo so the next burst is recorded", () => {
    const { history, advance } = historyWithClock();
    history.record({ text: "one", caret: 3 });
    advance(50);
    expect(history.undo()).toEqual({ text: "one", caret: 3 });

    history.record({ text: "two", caret: 3 });
    expect(history.depth()).toBe(1);
  });

  it("forgets everything on reset", () => {
    const { history } = historyWithClock();
    history.record({ text: "draft", caret: 5 });
    history.reset();

    expect(history.depth()).toBe(0);
    expect(history.undo()).toBeNull();
  });
});
