import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { formatHint, hintFor } from "@/ui/chrome/panel-hints.ts";
import {
  type EnrichedSessionEntry,
  formatRelative,
  formatSessionSize,
  metaTextFor,
  scanSessionHead,
  searchTextFor,
} from "../entries";
import { listHints, renderResumeRowLines } from "../picker-view.ts";

describe("resume entry helpers", () => {
  it("formats the timestamp, branch, and compact file size on the metadata row", () => {
    const entry: EnrichedSessionEntry = {
      phase: "enriched",
      id: "session",
      path: "/workspace/session.jsonl",
      updatedAt: 965_000,
      sizeBytes: 45_158,
      slugMatched: true,
      title: "Title",
      preview: "Preview",
      cwd: "/workspace",
      branch: "HEAD",
    };

    expect(formatRelative(entry.updatedAt, 1_000_000)).toBe("35 seconds ago");
    expect(formatSessionSize(entry.sizeBytes)).toBe("44.1KB");
    expect(metaTextFor(entry, 1_000_000)).toBe("35 seconds ago · HEAD · 44.1KB");
  });

  it("renders each session as title, metadata, and spacer rows", () => {
    const lines = renderResumeRowLines(
      {
        label: "Checkpoint",
        description: "35 seconds ago · HEAD · 44.1KB",
        selected: true,
        labelBold: false,
        rows: 3,
      },
      72,
    ).map(stripAnsi);

    expect(lines).toEqual(["❯ Checkpoint", "  35 seconds ago · HEAD · 44.1KB", ""]);
  });

  it("phrases the list hints through the shared hint dictionary", () => {
    const hints = listHints("HEAD", false, false, true).map(formatHint);

    expect(hints).toEqual([
      "Ctrl+A to show all projects",
      "Ctrl+B to only show current branch",
      formatHint(hintFor("spacePreview")),
      formatHint(hintFor("rename")),
      formatHint(hintFor("typeToSearch")),
      formatHint(hintFor("cancel")),
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
