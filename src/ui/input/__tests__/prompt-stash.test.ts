import { describe, expect, it } from "bun:test";
import { PromptStash } from "@/ui/input/prompt-stash.ts";

describe("PromptStash", () => {
  it("parks the draft and hands it back with its caret", () => {
    const stash = new PromptStash();

    expect(stash.toggle({ text: "half a thought", caret: 4 })).toEqual({
      kind: "stashed",
      draft: { text: "", caret: 0 },
    });
    expect(stash.has()).toBe(true);

    expect(stash.toggle({ text: "", caret: 0 })).toEqual({
      kind: "restored",
      draft: { text: "half a thought", caret: 4 },
    });
    expect(stash.has()).toBe(false);
  });

  it("does nothing on an empty prompt with nothing parked", () => {
    const stash = new PromptStash();

    expect(stash.toggle({ text: "", caret: 0 })).toEqual({ kind: "none" });
    expect(stash.has()).toBe(false);
  });

  it("keeps one slot: stashing again replaces what was parked", () => {
    const stash = new PromptStash();

    stash.toggle({ text: "first", caret: 5 });
    stash.toggle({ text: "second", caret: 6 });

    expect(stash.toggle({ text: "", caret: 0 })).toEqual({
      kind: "restored",
      draft: { text: "second", caret: 6 },
    });
    expect(stash.toggle({ text: "", caret: 0 })).toEqual({ kind: "none" });
  });

  it("forgets the slot on clear", () => {
    const stash = new PromptStash();
    stash.toggle({ text: "draft", caret: 5 });

    stash.clear();

    expect(stash.has()).toBe(false);
    expect(stash.toggle({ text: "", caret: 0 })).toEqual({ kind: "none" });
  });
});
