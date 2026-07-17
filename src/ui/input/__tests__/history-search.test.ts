import { describe, expect, it } from "bun:test";
import { findHistoryMatch } from "@/ui/input/history-search.ts";

// Entries are oldest-first, as the prompt history stores them.
const entries = ["build the app", "run tests", "fix build error", "run tests"];

describe("findHistoryMatch", () => {
  it("finds the newest entry containing the query", () => {
    expect(findHistoryMatch(entries, "run", 0)).toEqual({
      scanIndex: 0,
      value: "run tests",
      matchOffset: 0,
    });
  });

  it("continues toward older entries from a scan index", () => {
    expect(findHistoryMatch(entries, "build", 0)).toEqual({
      scanIndex: 1,
      value: "fix build error",
      matchOffset: 4,
    });
    expect(findHistoryMatch(entries, "build", 2)).toEqual({
      scanIndex: 3,
      value: "build the app",
      matchOffset: 0,
    });
  });

  it("skips duplicate displays", () => {
    // The older "run tests" duplicate never surfaces as a second match.
    expect(findHistoryMatch(entries, "run", 1)).toBeNull();
  });

  it("reports the last occurrence inside an entry", () => {
    expect(findHistoryMatch(["echo a; echo b"], "echo", 0)?.matchOffset).toBe(8);
  });

  it("returns null for an empty query or no match", () => {
    expect(findHistoryMatch(entries, "", 0)).toBeNull();
    expect(findHistoryMatch(entries, "zzz", 0)).toBeNull();
  });
});
