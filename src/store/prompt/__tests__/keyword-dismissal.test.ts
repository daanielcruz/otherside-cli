import { afterEach, describe, expect, test } from "bun:test";
import { promptStore, setPromptKeywordDismissed } from "@/store/prompt/index.ts";

afterEach(() => {
  setPromptKeywordDismissed(false);
});

describe("turning this draft's keyword off", () => {
  test("starts on, because a draft with the word in it meant it", () => {
    expect(promptStore.getState().keywordDismissed).toBe(false);
  });

  test("goes off and back on, so a press is undoable by the same press", () => {
    setPromptKeywordDismissed(true);
    expect(promptStore.getState().keywordDismissed).toBe(true);
    setPromptKeywordDismissed(false);
    expect(promptStore.getState().keywordDismissed).toBe(false);
  });

  test("setting what is already set leaves the state object alone", () => {
    // The prompt repaints on every store change; a set that changes nothing
    // must not be a change.
    const before = promptStore.getState();
    setPromptKeywordDismissed(false);
    expect(promptStore.getState()).toBe(before);
  });
});
