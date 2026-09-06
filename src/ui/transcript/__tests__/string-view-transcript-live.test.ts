import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { transcriptActions } from "@/store/transcript/index.ts";
import { transcriptLiveActions } from "@/store/transcript/live.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { Glyph } from "@/ui/theme/theme.ts";
import type { ToolEntryData } from "@/ui/transcript/string-view-tool.ts";
import { type SettledEntry, StringViewTranscript } from "@/ui/transcript/string-view-transcript.ts";

const WIDTH = 60;
const originalColorLevel = chalk.level;
let transcript: StringViewTranscript | undefined;
let renders = 0;

function mount(): StringViewTranscript {
  const view = new StringViewTranscript();
  view.mount({
    requestRender: () => {
      renders += 1;
    },
    pushFocus: () => {},
    popFocus: () => {},
  });
  return view;
}

beforeAll(() => {
  chalk.level = 3;
});

beforeEach(() => {
  renders = 0;
  transcriptActions.clear();
  transcriptLiveActions.reset();
});

afterEach(() => {
  transcript?.unmount();
  transcript = undefined;
  transcriptActions.clear();
  transcriptLiveActions.reset();
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

describe("StringViewTranscript live streaming", () => {
  it("renders the in-flight assistant tail and thinking, then clears on reset", () => {
    transcript = mount();

    expect(plain(transcript.render(WIDTH)).join("\n")).not.toContain("token");

    transcriptLiveActions.setStreamingId("a_live_0");
    transcriptLiveActions.setStreamingThinking("weighing the token budget");
    transcriptLiveActions.setStreamingText("first token of the reply");
    const streaming = plain(transcript.render(WIDTH)).join("\n");
    expect(streaming).toContain("weighing the token budget");
    expect(streaming).toContain("first token of the reply");

    transcriptLiveActions.reset();
    expect(plain(transcript.render(WIDTH)).join("\n")).not.toContain("first token of the reply");
  });

  it("shows only the uncommitted tail past the committed length", () => {
    transcript = mount();
    transcriptLiveActions.setStreamingId("a_live_1");
    transcriptLiveActions.setStreamingText("committed head UNCOMMITTED-TAIL");
    transcriptLiveActions.setCommittedLen(() => "committed head ".length);
    const streaming = plain(transcript.render(WIDTH)).join("\n");
    expect(streaming).toContain("UNCOMMITTED-TAIL");
    expect(streaming).not.toContain("committed head");
  });

  it("keeps one assistant bullet when a second chunk streams after a committed chunk", () => {
    const firstChunk = "First paragraph.\n\n";
    const secondChunk = "Second paragraph continues the same reply.";
    transcript = mount();
    transcriptLiveActions.setStreamingId("a_live_chunks");
    transcriptLiveActions.setStreamingText(firstChunk);

    transcriptActions.settle({ id: "a_chunk_1", kind: "assistant", text: firstChunk });
    transcriptLiveActions.setStreamingText(firstChunk + secondChunk);
    transcriptLiveActions.setCommittedLen(() => firstChunk.length);

    const liveReply = plain(transcript.render(WIDTH)).join("\n");
    expect(liveReply).toContain("First paragraph.");
    expect(liveReply).toContain("Second paragraph continues the same reply.");
    expect(liveReply.split(Glyph.bullet).length - 1).toBe(1);

    transcriptActions.settle({
      id: "a_chunk_2",
      kind: "assistant",
      text: secondChunk,
      continuation: true,
    });
    transcriptLiveActions.reset();
    const settledReply = plain(transcript.render(WIDTH)).join("\n");
    expect(settledReply.split(Glyph.bullet).length - 1).toBe(1);
  });

  it("requests a render when the live store changes", () => {
    transcript = mount();
    const before = renders;
    transcriptLiveActions.setStreamingId("a_live_2");
    transcriptLiveActions.setStreamingText("streaming");
    expect(renders).toBeGreaterThan(before);
  });

  it("does not reprocess settled entries during live and prompt-frame renders", () => {
    transcript = mount();
    let settledReads = 0;
    const settled = {
      get kind() {
        settledReads += 1;
        return "assistant" as const;
      },
      text: "settled once",
    };
    transcript.setEntries([settled]);
    expect(transcript.takeScrollbackBatch(WIDTH).mode).toBe("reflow");
    const readsAfterSettle = settledReads;

    transcriptLiveActions.setStreamingId("a_live_3");
    transcriptLiveActions.setStreamingText("live one");
    expect(plain(transcript.renderLive(WIDTH)).join("\n")).toContain("live one");
    transcriptLiveActions.setStreamingText("live two");
    expect(plain(transcript.renderLive(WIDTH)).join("\n")).toContain("live two");
    expect(transcript.takeScrollbackBatch(WIDTH)).toEqual({ mode: "idle" });
    expect(settledReads).toBe(readsAfterSettle);
  });

  it("emits each newly settled entry once and rebuilds all entries on resize", () => {
    transcript = mount();
    transcript.setEntries([{ kind: "assistant", text: "first settled" }]);
    expect(transcript.takeScrollbackBatch(WIDTH).mode).toBe("reflow");

    transcript.append({ kind: "assistant", text: "second settled" });
    const append = transcript.takeScrollbackBatch(WIDTH);
    expect(append.mode).toBe("add");
    expect(append.mode === "add" ? plain([...append.rows]).join("\n") : "").toContain(
      "second settled",
    );
    expect(transcript.takeScrollbackBatch(WIDTH)).toEqual({ mode: "idle" });

    const resized = plain([...transcript.snapshotScrollback(24)]).join("\n");
    expect(resized).toContain("first settled");
    expect(resized).toContain("second settled");
    expect(transcript.takeScrollbackBatch(24)).toEqual({ mode: "idle" });
  });

  /**
   * A running tool rebuilds its row from the clock on every paint, so it belongs to the
   * live frame until it stops. Kept in the document it would re-lay-out the whole
   * document once per tick — a cost set by the history above it, not by the row.
   */
  it("keeps a running tool out of the document and settles it once complete", () => {
    const history = Array.from(
      { length: 40 },
      (_, index): SettledEntry => ({ kind: "assistant", text: `history ${index}` }),
    );
    const toolRow = (fields: Partial<ToolEntryData>): SettledEntry => ({
      kind: "tool",
      data: {
        name: "Bash",
        args: { command: "seq 40" },
        payload: null,
        isBackgrounded: false,
        ...fields,
      } as ToolEntryData,
    });

    transcript = mount();
    transcript.setEntries([...history, toolRow({ status: "running", elapsedMs: 1_000 })]);
    transcript.snapshotScrollback(WIDTH);

    // The elapsed readout ticks; the document must not notice.
    for (let second = 2; second <= 10; second++) {
      transcript.setEntries([
        ...history,
        toolRow({ status: "running", elapsedMs: second * 1_000 }),
      ]);
      expect(transcript.takeScrollbackBatch(WIDTH)).toEqual({ mode: "idle" });
    }
    expect(plain(transcript.renderLive(WIDTH)).join("\n")).toContain("Bash");

    // Completing drops the clock, so the row is finished text and joins the document.
    transcript.setEntries([
      ...history,
      toolRow({ status: "ok", payload: { kind: "preview", text: "done" } }),
    ]);
    const settled = transcript.takeScrollbackBatch(WIDTH);
    expect(settled.mode).toBe("add");
    expect(settled.mode === "add" ? plain([...settled.rows]).join("\n") : "").toContain("Bash");
    expect(plain(transcript.renderLive(WIDTH)).join("\n")).not.toContain("Bash");
  });

  /**
   * A backgrounded agent's row settles at launch with a frozen projection, so the
   * text after it joins the document immediately instead of hanging invisible for
   * the task's whole life. The completion restamp changes settled history once and
   * goes through the non-destructive reflow path — no ghosts, no duplicates.
   */
  it("settles a backgrounded agent's row at launch and reflows once on completion", () => {
    const history = Array.from(
      { length: 40 },
      (_, index): SettledEntry => ({ kind: "assistant", text: `history ${index}` }),
    );
    const agentRow = (fields: Partial<ToolEntryData>): SettledEntry => ({
      kind: "tool",
      data: {
        name: "Agent",
        args: { description: "count the files" },
        status: "ok",
        payload: null,
        isBackgrounded: true,
        ...fields,
      } as ToolEntryData,
    });
    const afterText: SettledEntry = { kind: "assistant", text: "text after the agent row" };

    transcript = mount();
    transcript.setEntries([...history, agentRow({})]);
    transcript.snapshotScrollback(WIDTH);

    // Text arriving after the launched row settles right away — the row holds
    // nothing back while the task runs.
    transcript.setEntries([...history, agentRow({}), afterText]);
    const appended = transcript.takeScrollbackBatch(WIDTH);
    expect(appended.mode).toBe("add");
    expect(appended.mode === "add" ? plain([...appended.rows]).join("\n") : "").toContain(
      "text after the agent row",
    );

    // The frozen projection re-derives identically while the task runs; the
    // document must not notice the task store's churn.
    transcript.setEntries([...history, agentRow({}), afterText]);
    expect(transcript.takeScrollbackBatch(WIDTH)).toEqual({ mode: "idle" });

    // Completion restamps the row with frozen data the backgrounded render does
    // not show (nested actions): settled history changed but no rendered row
    // did, so the archive repaint downgrades to a no-op instead of erasing and
    // rewriting the terminal buffer.
    transcript.setEntries([
      ...history,
      agentRow({ nested: [{ toolName: "Read", args: null, running: false }] }),
      afterText,
    ]);
    expect(transcript.takeScrollbackBatch(WIDTH)).toEqual({ mode: "idle" });

    // A restamp that DOES change a rendered row reflows the archive once, and
    // the regenerated buffer carries exactly one copy of every line.
    transcript.setEntries([
      ...history,
      agentRow({ args: { description: "count the files (12 found)" } }),
      afterText,
    ]);
    const restamped = transcript.takeScrollbackBatch(WIDTH);
    expect(restamped.mode).toBe("reflow");
    const rows = restamped.mode === "reflow" ? plain([...restamped.rows]).join("\n") : "";
    expect(rows.split("text after the agent row").length - 1).toBe(1);
    expect(rows.split("history 39").length - 1).toBe(1);
  });

  /** A sync (non-backgrounded) agent task still rides the live frame until it ends. */
  it("keeps a sync agent's row live while its task feeds it", () => {
    const history: SettledEntry[] = [{ kind: "assistant", text: "before the sync agent" }];
    const agentRow = (fields: Partial<ToolEntryData>): SettledEntry => ({
      kind: "tool",
      data: {
        name: "Agent",
        args: { description: "sync verification" },
        status: "ok",
        payload: null,
        isBackgrounded: false,
        ...fields,
      } as ToolEntryData,
    });

    transcript = mount();
    transcript.setEntries([...history, agentRow({ taskRunning: true })]);
    transcript.snapshotScrollback(WIDTH);
    transcript.setEntries([
      ...history,
      agentRow({
        taskRunning: true,
        nested: [{ toolName: "Read", args: null, running: true }],
      }),
    ]);
    expect(transcript.takeScrollbackBatch(WIDTH)).toEqual({ mode: "idle" });
    expect(plain(transcript.renderLive(WIDTH)).join("\n")).toContain("sync verification");

    transcript.setEntries([...history, agentRow({})]);
    const settled = transcript.takeScrollbackBatch(WIDTH);
    expect(settled.mode).toBe("add");
    expect(plain(transcript.renderLive(WIDTH)).join("\n")).not.toContain("sync verification");
  });
});

function plain(lines: string[]): string[] {
  return lines.map(stripAnsi);
}
