import { describe, expect, it } from "bun:test";
import {
  type EnrichedSessionEntry,
  resumeMaxHeight,
  scanSessionHead,
  searchTextFor,
  visibleResumeRows,
} from "../entries";

describe("resume entry helpers", () => {
  it("derives the reference row geometry", () => {
    expect([45, 24, 80].map((rows) => [resumeMaxHeight(rows), visibleResumeRows(rows)])).toEqual([
      [29, 6],
      [15, 1],
      [52, 14],
    ]);
  });

  it("scans the first branch in the session head", () => {
    const scan = scanSessionHead(
      [
        JSON.stringify({ gitBranch: "feature/session", cwd: "/work" }),
        JSON.stringify({
          gitBranch: "later",
          type: "user",
          message: { content: [{ type: "text", text: "Hello" }] },
        }),
      ].join("\n"),
    );

    expect(scan).toEqual({ cwd: "/work", branch: "feature/session", preview: "Hello" });
  });

  it("includes the branch in searchable text", () => {
    const entry: EnrichedSessionEntry = {
      phase: "enriched",
      id: "session",
      path: "/tmp/session.jsonl",
      updatedAt: 0,
      sizeBytes: 1,
      slugMatched: true,
      title: "Title",
      preview: "Preview",
      cwd: "/work",
      branch: "feature/searchable",
    };

    expect(searchTextFor(entry)).toContain("feature/searchable");
  });
});
