import { beforeEach, describe, expect, it } from "bun:test";
import { getTranscriptEntries, transcriptActions } from "../index.ts";

describe("transcript store", () => {
  beforeEach(() => {
    transcriptActions.clear();
  });

  it("appends and settles entries as a single SoT", () => {
    transcriptActions.appendProvisional({ id: "e1", kind: "user", text: "hi" });
    transcriptActions.settle({ id: "e1", kind: "user", text: "hi" });
    expect(getTranscriptEntries()).toEqual([
      { id: "e1", kind: "user", text: "hi", settlementState: "settled" },
    ]);
  });

  it("replaces every entry atomically", () => {
    transcriptActions.settle({ id: "old", kind: "user", text: "old" });
    transcriptActions.replace([{ id: "new", kind: "user", text: "new" }]);
    expect(getTranscriptEntries().map((entry) => entry.id)).toEqual(["new"]);
  });
});
