import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import chalk from "chalk";
import {
  INTERRUPT_MESSAGE,
  INTERRUPTED_FEEDBACK,
} from "@/engine/queue/runtime/interruption-text.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { transcriptActions } from "@/store/transcript/index.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { Color, Glyph, GUTTER_CONT, GUTTER_HEAD } from "@/ui/theme/theme.ts";
import { mapTranscriptEntries } from "@/ui/transcript/string-view-store.ts";
import { type SettledEntry, StringViewTranscript } from "@/ui/transcript/string-view-transcript.ts";

const originalColorLevel = chalk.level;
let transcript: StringViewTranscript | undefined;

beforeAll(() => {
  chalk.level = 3;
});

beforeEach(() => {
  transcriptActions.clear();
});

afterEach(() => {
  transcript?.unmount();
  transcript = undefined;
  transcriptActions.clear();
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

describe("StringViewTranscript store subscription", () => {
  it("maps current entries and requests renders for later store mutations", () => {
    transcriptActions.appendProvisional({
      id: "u_store",
      kind: "user",
      text: "store user",
    });
    transcriptActions.settle({
      id: "a_store",
      kind: "assistant",
      text: "store **assistant**",
    });
    transcriptActions.settle({
      id: "r_store_tool",
      kind: "tool",
      title: "Read",
      input: JSON.stringify({ file_path: "/workspace/store.ts" }),
      text: "one\ntwo",
      resultMeta: { kind: "read", numLines: 2, startLine: 1, totalLines: 2 },
    });
    transcriptActions.settle({
      id: "thinking_store",
      kind: "thinking",
      text: "not mapped yet",
    });

    let renderRequests = 0;
    transcript = new StringViewTranscript();
    transcript.mount({
      requestRender: () => renderRequests++,
      pushFocus: () => {},
      popFocus: () => {},
    });

    const initial = stripAnsi(transcript.render(80).join("\n"));
    expect(initial).toContain("store user");
    expect(initial).toContain("store assistant");
    expect(initial).toContain("Read(/workspace/store.ts)");
    expect(initial).toContain("Read 2 lines");
    expect(initial).toContain(`${Glyph.therefore} not mapped yet`);
    expect(renderRequests).toBe(1);

    transcriptActions.appendProvisional({
      id: "a_later",
      kind: "assistant",
      text: "reactive append",
    });

    expect(stripAnsi(transcript.render(80).join("\n"))).toContain("reactive append");
    expect(renderRequests).toBe(2);
  });

  it("unsubscribes from transcript updates on unmount", () => {
    let renderRequests = 0;
    transcript = new StringViewTranscript();
    transcript.mount({
      requestRender: () => renderRequests++,
      pushFocus: () => {},
      popFocus: () => {},
    });
    transcript.unmount();

    transcriptActions.appendProvisional({
      id: "u_after_unmount",
      kind: "user",
      text: "ignored after unmount",
    });

    expect(renderRequests).toBe(1);
    expect(stripAnsi(transcript.render(80).join("\n"))).not.toContain("ignored after unmount");
  });
});

describe("common string-view transcript entries", () => {
  const sourceEntries: TranscriptEntry[] = [
    { id: "thinking_kind", kind: "thinking", text: "**careful thought**" },
    { id: "system_kind", kind: "system", text: "system note" },
    { id: "slash_kind", kind: "slash_error", text: "slash failed" },
    { id: "skill_kind", kind: "skill", text: "skill failed", isError: true },
    {
      id: "compaction_kind",
      kind: "compaction",
      text: "conversation compacted",
      filesRead: [{ path: "/workspace/OTHERSIDE.md", numLines: 3 }],
    },
    { id: "compact_done_kind", kind: "compact_done", text: "compaction complete" },
  ];

  it("maps every common non-message kind", () => {
    expect(mapTranscriptEntries(sourceEntries).map((entry) => entry.kind)).toEqual([
      "thinking",
      "system",
      "slash_error",
      "skill",
      "compaction",
      "compact_done",
    ]);
  });

  it("gives each kind its own gutter and styling", () => {
    const mapped = mapTranscriptEntries(sourceEntries);
    // A whole line of bold is spoken plainly: its markers come off and it does not
    // brighten out of the dimmed block it belongs to.
    const thinking = renderEntry(mapped[0]);
    expect(thinking.plain[0]).toBe(`${Glyph.therefore} careful thought`);
    expect(thinking.raw[0]).toContain("\x1b[3m");
    expect(thinking.raw[0]).toContain("\x1b[2m");
    expect(thinking.raw[0]).not.toContain("\x1b[1m");

    const system = renderEntry(mapped[1]);
    expect(system.plain[0]).toBe(`${Glyph.systemBullet}system note`);
    expect(system.raw[0]).toContain(renderTextWithStyles("system note", { color: Color.system }));

    const slashError = renderEntry(mapped[2]);
    expect(slashError.plain[0]).toBe(`${Glyph.bullet} slash failed`);
    expect(slashError.raw[0]).toContain(
      renderTextWithStyles("slash failed", { color: Color.warning }),
    );

    const skill = renderEntry(mapped[3]);
    expect(skill.plain[0]).toBe(`${Glyph.bullet} skill failed`);
    expect(skill.raw[0]).toContain(
      renderTextWithStyles(`${Glyph.bullet} `, { color: Color.error }),
    );
    expect(skill.raw[0]).toContain(renderTextWithStyles("skill failed", { color: Color.text }));

    const compaction = renderEntry(mapped[4]);
    expect(compaction.plain[0]).toBe(`${Glyph.bullet} conversation compacted`);
    expect(compaction.plain[1]).toBe(`${GUTTER_HEAD}Read /workspace/OTHERSIDE.md (3 lines)`);
    expect(compaction.raw[0]).toContain(
      renderTextWithStyles("conversation compacted", { color: Color.muted }),
    );

    const compactDone = renderEntry(mapped[5]);
    expect(compactDone.plain[0]).toBe(`${Glyph.lozenge} compaction complete`);
    expect(compactDone.raw[0]).toContain(
      renderTextWithStyles("compaction complete", { color: Color.muted }),
    );
  });
});

describe("specialized string-view transcript entries", () => {
  const entries: TranscriptEntry[] = [
    {
      id: "retry_kind",
      kind: "retry",
      text: "HTTP 429",
      input: JSON.stringify({ attempt: 2, maxAttempts: 5, seconds: 5, startedAt: 0 }),
    },
    { id: "command_kind", kind: "command_output", text: "plugins updated" },
    { id: "quota_kind", kind: "quota_gutter", text: "quota reached" },
    {
      id: "ask_kind",
      kind: "ask_answer",
      text: "",
      askPayload: {
        declined: false,
        answers: [{ question: "Continue?", answer: "Yes" }],
      },
    },
  ];

  it("maps retry, command output, quota, and question answers", () => {
    expect(mapTranscriptEntries(entries).map((entry) => entry.kind)).toEqual([
      "retry",
      "command_output",
      "quota_gutter",
      "ask_answer",
    ]);
  });

  it("renders their complete visible content", () => {
    const [retry, command, quota, answer] = mapTranscriptEntries(entries).map(renderEntry);
    expect(retry?.plain).toEqual([
      `${GUTTER_HEAD}Rate limited`,
      `${GUTTER_CONT}Retrying in 5s · attempt 2/5`,
    ]);
    expect(command?.plain).toEqual([`${GUTTER_HEAD}plugins updated`]);
    expect(quota?.plain).toEqual([`${GUTTER_HEAD}quota reached`]);
    expect(answer?.plain.join("\n")).toContain("User answered Otherside's questions:");
    expect(answer?.plain.join("\n")).toContain("· Continue? → Yes");
  });

  it("renders interruption feedback instead of the conversation marker", () => {
    const view = new StringViewTranscript();
    view.setEntries([{ kind: "system", text: INTERRUPT_MESSAGE, isError: false }]);
    const rows = view.render(80).map(stripAnsi);

    expect(rows).toEqual([`${GUTTER_HEAD}${INTERRUPTED_FEEDBACK}`]);
    expect(rows.join("\n")).not.toContain(INTERRUPT_MESSAGE);
  });

  it("hugs the interrupted block instead of opening a new one", () => {
    const view = new StringViewTranscript();
    view.setEntries([
      { kind: "assistant", text: "partial answer" },
      { kind: "system", text: INTERRUPT_MESSAGE, isError: false },
    ]);
    const rows = view.render(80).map(stripAnsi);

    expect(rows[rows.length - 2]).toContain("partial answer");
    expect(rows[rows.length - 1]).toBe(`${GUTTER_HEAD}${INTERRUPTED_FEEDBACK}`);
  });
});

function renderEntry(entry: SettledEntry | undefined): { raw: string[]; plain: string[] } {
  if (!entry) throw new Error("expected mapped transcript entry");
  const view = new StringViewTranscript();
  view.setEntries([entry]);
  const rows = view.render(80);
  // An attaching entry (a command's output) hugs the block above it, so it
  // opens with content; every other kind opens its own block with a blank.
  const raw = rows[0] === "" ? rows.slice(1) : rows;
  return { raw, plain: raw.map(stripAnsi) };
}
