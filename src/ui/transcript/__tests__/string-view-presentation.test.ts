import { afterEach, describe, expect, it } from "bun:test";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import type { AppState } from "@/store/app-store/types.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import {
  foldOutputRows,
  outputFoldHint,
  transcriptPresentationFor,
  wrapOutputRows,
} from "@/ui/transcript/presentation.ts";
import {
  entryLines,
  renderSettledEntries,
  StringViewTranscript,
} from "@/ui/transcript/string-view-transcript.ts";

const initialAppState: AppState = appStore.getState();

afterEach(() => {
  appStore.setState(() => initialAppState);
});

describe("string-view presentation policy", () => {
  it("keeps the four-row exception and folds five physical rows", () => {
    expect(foldOutputRows(["one", "two", "three", "four"], { expanded: false })).toEqual({
      visible: ["one", "two", "three", "four"],
      hidden: 0,
    });
    const folded = foldOutputRows(["one", "two", "three", "four", "five"], {
      expanded: false,
    });
    expect(folded.visible).toEqual(["one", "two", "three"]);
    expect(outputFoldHint(folded.hidden)).toBe("… +2 lines (ctrl+o to expand)");
  });

  it("wraps ANSI Unicode output by terminal cells before folding", () => {
    const rows = wrapOutputRows("\x1b[31m😀ab😀cd\x1b[0m", 4);
    expect(rows.map(stripAnsi)).toEqual(["😀ab", "😀cd"]);
  });

  it("derives compact, verbose, and detailed without mixing their owners", () => {
    expect(transcriptPresentationFor("prompt", false)).toBe("compact");
    expect(transcriptPresentationFor("prompt", true)).toBe("verbose");
    expect(transcriptPresentationFor("detailed", false)).toBe("detailed");
    expect(transcriptPresentationFor("detailed", true)).toBe("detailed");
  });

  it("keeps detail-only thinking out of every surface but the detailed reader", () => {
    const entries = [
      { kind: "assistant" as const, text: "answer" },
      { kind: "thinking" as const, text: "replayed reasoning", detailOnly: true },
    ];
    const compact = plain(renderSettledEntries(80, entries, "compact")).join("\n");
    const verbose = plain(renderSettledEntries(80, entries, "verbose")).join("\n");
    const detailed = plain(renderSettledEntries(80, entries, "detailed")).join("\n");

    expect(compact).not.toContain("replayed reasoning");
    expect(verbose).not.toContain("replayed reasoning");
    expect(detailed).toContain("replayed reasoning");
    // Live thinking (no flag) stays visible on the prompt screen.
    const live = plain(
      renderSettledEntries(80, [{ kind: "thinking", text: "live reasoning" }], "compact"),
    ).join("\n");
    expect(live).toContain("live reasoning");
  });

  it("folds tool payloads only in compact presentation", () => {
    const entry = {
      kind: "tool" as const,
      data: {
        name: "Read",
        args: { file_path: "/workspace/fixture.ts" },
        status: "ok" as const,
        payload: { kind: "preview" as const, text: "one\ntwo\nthree\nfour\nfive" },
      },
    };
    const compact = plain(entryLines(entry, 80, "compact"));
    const verbose = plain(entryLines(entry, 80, "verbose"));

    expect(compact.join("\n")).toContain("… +2 lines (ctrl+o to expand)");
    expect(compact.join("\n")).not.toContain("five");
    expect(verbose.join("\n")).toContain("five");
    expect(verbose.join("\n")).not.toContain("ctrl+o to expand");
  });

  // Reasoning is always on screen here, so it is always read as the markdown it was
  // written as. Collapsing it to one paragraph in the tighter view would drop the
  // structure the model put there, and it would drop it in the only view most sessions
  // ever use.
  it("keeps thinking's own structure in every presentation", () => {
    const entry = { kind: "thinking" as const, text: "first paragraph\n\nsecond paragraph" };
    const compact = plain(entryLines(entry, 80, "compact"));

    expect(compact.length).toBeGreaterThan(1);
    expect(compact).toEqual(plain(entryLines(entry, 80, "verbose")));
  });

  it("truncates long errors only in compact presentation", () => {
    const text = `${"x".repeat(1_100)}TAIL`;
    const entry = { kind: "api_error" as const, text };
    const compact = plain(entryLines(entry, 200, "compact")).join("\n");
    const verbose = plain(entryLines(entry, 200, "verbose")).join("\n");

    expect(compact).not.toContain("TAIL");
    expect(compact).toContain("(ctrl+o to expand)");
    expect(verbose).toContain("TAIL");
  });

  it("restores long user input only in detailed presentation", () => {
    const text = `${"a".repeat(5_100)}MIDDLE${"z".repeat(5_100)}`;
    const entry = { kind: "user" as const, text };
    const compact = plain(entryLines(entry, 200, "compact")).join("\n");
    const detailed = plain(entryLines(entry, 200, "detailed")).join("\n");

    expect(compact).not.toContain("MIDDLE");
    expect(detailed).toContain("MIDDLE");
  });

  it("keeps compaction file details in every presentation and never folds them", () => {
    const entry = {
      kind: "compaction" as const,
      text: "Conversation compacted",
      isError: false,
      filesRead: [{ path: "/workspace/one.ts", numLines: 10 }],
    };

    for (const presentation of ["compact", "verbose", "detailed"] as const) {
      const rendered = plain(entryLines(entry, 80, presentation)).join("\n");
      expect(rendered).toContain("Read /workspace/one.ts (10 lines)");
      expect(rendered).not.toContain("(ctrl+o to expand)");
    }
  });

  it("uses a completion chip until detailed restores nested Agent content", () => {
    const entry = {
      kind: "tool" as const,
      data: {
        name: "Agent",
        args: { description: "audit fixture", subagent_type: "general-purpose" },
        status: "ok" as const,
        payload: null,
        completionChip: {
          id: "call-1",
          kind: "completed" as const,
          taskKind: "agent" as const,
          description: "audit fixture",
        },
        nested: [{ toolName: "Read", args: { file_path: "/workspace/one.ts" }, running: false }],
      },
    };
    const compact = plain(entryLines(entry, 100, "compact")).join("\n");
    const detailed = plain(entryLines(entry, 100, "detailed")).join("\n");

    expect(compact).toContain('Agent "audit fixture" completed');
    expect(compact).not.toContain("one.ts");
    expect(detailed).toContain("one.ts");
  });

  it("keeps skill progress at a three-row tail until detailed", () => {
    const entry = {
      kind: "skill" as const,
      text: "",
      isError: false,
      progress: ["one", "two", "three", "four", "five"].map((text) => ({
        kind: "text" as const,
        text,
      })),
    };
    const compact = plain(entryLines(entry, 80, "compact")).join("\n");
    const verbose = plain(entryLines(entry, 80, "verbose")).join("\n");
    const detailed = plain(entryLines(entry, 80, "detailed")).join("\n");

    expect(compact).not.toContain("one");
    expect(compact).toContain("three");
    expect(compact).toContain("+2 more tool uses (ctrl+o to expand)");
    expect(verbose).toBe(compact);
    expect(detailed).toContain("one");
  });
});

describe("StringViewTranscript presentation subscription", () => {
  it("reads the live verbose state and follows detailed state from the app store", () => {
    let requests = 0;
    dispatch({ type: "view/setVerboseTranscript", verbose: true });
    const transcript = new StringViewTranscript();
    transcript.mount({
      requestRender: () => requests++,
      pushFocus: () => {},
      popFocus: () => {},
    });
    expect(transcript.getPresentation()).toBe("verbose");

    dispatch({ type: "view/toggleTranscriptScreen" });
    expect(transcript.getPresentation()).toBe("detailed");
    expect(requests).toBe(2);

    // The store is the live source: /config flips it without a rebuild.
    dispatch({ type: "view/toggleTranscriptScreen" });
    dispatch({ type: "view/setVerboseTranscript", verbose: false });
    expect(transcript.getPresentation()).toBe("compact");

    transcript.unmount();
  });
});

function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi);
}
