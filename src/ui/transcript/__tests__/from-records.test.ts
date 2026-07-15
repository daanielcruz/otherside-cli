import { describe, expect, it } from "bun:test";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import { sessionRecordsToTranscript } from "../records/from-records.ts";
import { projectAgentTranscript } from "../stream/poll.ts";

describe("sessionRecordsToTranscript with content_replacement", () => {
  it("replaces raw tool result text with replacement sentinel when present", () => {
    const records: SessionRecord[] = [
      {
        type: "tool_call",
        ts: "2026-06-23T00:00:00.000Z",
        call_id: "call-1",
        tool_name: "Read",
        args: { path: "foo.txt" },
      },
      {
        type: "tool_result",
        ts: "2026-06-23T00:00:00.000Z",
        call_id: "call-1",
        result: "original raw tool result content",
        is_error: false,
      },
      {
        type: "content_replacement",
        ts: "2026-06-23T00:00:00.000Z",
        kind: "tool-result",
        toolUseId: "call-1",
        replacement: "replaced content sentinel",
      },
    ];

    const entries = sessionRecordsToTranscript(records);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: "r_call-1",
      kind: "tool",
      title: "Read",
      text: "replaced content sentinel",
      isError: false,
      input: '{\n  "path": "foo.txt"\n}',
    });
  });

  it("retains raw tool result text if content_replacement is absent", () => {
    const records: SessionRecord[] = [
      {
        type: "tool_call",
        ts: "2026-06-23T00:00:00.000Z",
        call_id: "call-1",
        tool_name: "Read",
        args: { path: "foo.txt" },
      },
      {
        type: "tool_result",
        ts: "2026-06-23T00:00:00.000Z",
        call_id: "call-1",
        result: "original raw tool result content",
        is_error: false,
      },
    ];

    const entries = sessionRecordsToTranscript(records);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: "r_call-1",
      kind: "tool",
      title: "Read",
      text: "original raw tool result content",
      isError: false,
      input: '{\n  "path": "foo.txt"\n}',
    });
  });
});

describe("agent transcript projection", () => {
  it("includes assistant text, thinking, and producer metadata", () => {
    const records: SessionRecord[] = [
      {
        type: "assistant_message",
        ts: "2026-06-23T00:00:00.000Z",
        content: "Agent response",
        thinking: "Agent reasoning",
        provider: "codex",
        model: "gpt-5.5",
      },
    ];

    const view = projectAgentTranscript(records, true);

    expect(view.entries).toEqual([
      {
        id: "rec_0_th",
        kind: "thinking",
        text: "Agent reasoning",
        producedBy: "codex",
        producedModel: "gpt-5.5",
      },
      {
        id: "rec_0",
        kind: "assistant",
        text: "Agent response",
        producedBy: "codex",
        producedModel: "gpt-5.5",
      },
    ]);
  });

  it("preserves the producing model on completed tool entries", () => {
    const records: SessionRecord[] = [
      {
        type: "tool_call",
        ts: "2026-06-23T00:00:00.000Z",
        call_id: "call-1",
        tool_name: "Read",
        args: { path: "foo.txt" },
        provider: "codex",
        model: "gpt-5.5",
      },
      {
        type: "tool_result",
        ts: "2026-06-23T00:00:01.000Z",
        call_id: "call-1",
        result: "contents",
        is_error: false,
      },
    ];

    const toolEntry = projectAgentTranscript(records, true).entries[0];

    expect(toolEntry?.kind).toBe("tool");
    expect(toolEntry?.producedBy).toBe("codex");
    expect(toolEntry?.producedModel).toBe("gpt-5.5");
  });

  it("marks the parent LLM idle after its final response while child work continues", () => {
    const records: SessionRecord[] = [
      {
        type: "assistant_message",
        ts: "2026-06-23T00:00:00.000Z",
        content: "Waiting for the child agent",
        provider: "codex",
        model: "gpt-5.5",
      },
    ];

    expect(projectAgentTranscript(records, true).llmActive).toBe(false);
  });
});

describe("sessionRecordsToTranscript compaction_mark rendering", () => {
  it("renders a compaction_mark with a summary_ref as a compaction success line", () => {
    const records: SessionRecord[] = [
      {
        type: "compaction_mark",
        ts: "2026-06-23T00:00:00.000Z",
        summary_ref: "ref-123",
      },
    ];

    const entries = sessionRecordsToTranscript(records);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: "rec_0",
      kind: "compaction",
      text: "Conversation compacted",
      muted: true,
    });
  });

  it("renders a compaction_mark with empty summary_ref as a compact-FAILURE line", () => {
    const records: SessionRecord[] = [
      {
        type: "compaction_mark",
        ts: "2026-06-23T00:00:00.000Z",
        summary_ref: "",
        error: "auto compact failed error details",
      },
    ];

    const entries = sessionRecordsToTranscript(records);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: "rec_0",
      kind: "compaction",
      text: "Conversation compact failed — auto compact failed error details",
      muted: true,
      isError: true,
    });
  });
});
