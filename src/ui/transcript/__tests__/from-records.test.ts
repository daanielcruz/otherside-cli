import { describe, expect, it } from "bun:test";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import { parseTaskNotice } from "../blocks/task-notice.tsx";
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

  it("shows a background agent's persisted completion instead of the launch receipt", () => {
    const receipt =
      "Async agent launched successfully.\nagentId: agent-42\nThe agent is working in the background. You will be notified automatically when it completes.";
    const notification =
      '<task-notification>\n<task-id>agent-42</task-id>\n<status>failed</status>\n<summary>Agent "Fix worktree" failed · 121m 14s</summary>\n</task-notification>';
    const records: SessionRecord[] = [
      {
        type: "tool_call",
        ts: "2026-06-23T00:00:00.000Z",
        call_id: "call-1",
        tool_name: "Agent",
        args: { description: "Fix worktree" },
      },
      {
        type: "tool_result",
        ts: "2026-06-23T00:00:00.000Z",
        call_id: "call-1",
        result: receipt,
        is_error: false,
      },
      {
        type: "attachment",
        ts: "2026-06-23T00:10:00.000Z",
        attachment: {
          type: "queued_command",
          prompt: notification,
          commandMode: "task-notification",
          isMeta: true,
        },
      },
    ];

    const entries = sessionRecordsToTranscript(records);

    const tool = entries.find((entry) => entry.kind === "tool");
    expect(tool?.text).toBe('Agent "Fix worktree" failed · 121m 14s');
    expect(tool?.isError).toBe(true);
    const notice = entries.find((entry) => entry.kind === "task_notice");
    expect(parseTaskNotice(notice?.text ?? "")).toEqual({
      taskKind: "agent",
      status: "failed",
      description: "Fix worktree",
      durationMs: 7_274_000,
      taskId: "agent-42",
    });
    expect(notice?.isError).toBe(true);
  });

  it("keeps the launch receipt when no completion notification was recorded", () => {
    const receipt = "Async agent launched successfully.\nagentId: agent-77\nStill running.";
    const records: SessionRecord[] = [
      {
        type: "tool_call",
        ts: "2026-06-23T00:00:00.000Z",
        call_id: "call-1",
        tool_name: "Agent",
        args: {},
      },
      {
        type: "tool_result",
        ts: "2026-06-23T00:00:00.000Z",
        call_id: "call-1",
        result: receipt,
        is_error: false,
      },
    ];

    const entries = sessionRecordsToTranscript(records);

    expect(entries.find((entry) => entry.kind === "tool")?.text).toBe(receipt);
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

describe("sessionRecordsToTranscript thinking replay", () => {
  it("omits persisted thinking from the resumed main transcript", () => {
    const records: SessionRecord[] = [
      {
        type: "assistant_message",
        ts: "2026-06-23T00:00:00.000Z",
        content: "Visible answer",
        thinking: "Persisted reasoning",
        provider: "codex",
        model: "gpt-5.5",
      },
      {
        type: "assistant_message",
        ts: "2026-06-23T00:00:01.000Z",
        content: "",
        thinking: "Thinking-only fragment",
      },
    ];

    expect(sessionRecordsToTranscript(records)).toEqual([
      { id: "rec_0", kind: "assistant", text: "Visible answer" },
    ]);
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

describe("sessionRecordsToTranscript with bash-mode turns", () => {
  it("rebuilds a persisted bash turn as a bash_input echo with gutter meta", () => {
    const records: SessionRecord[] = [
      {
        type: "user_message",
        ts: "2026-06-23T00:00:00.000Z",
        content:
          "<bash-input>echo hi</bash-input>\n<bash-stdout>hi\n</bash-stdout><bash-stderr>warn &lt;x&gt;</bash-stderr>",
      },
    ];

    const entries = sessionRecordsToTranscript(records);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: "rec_0",
      kind: "bash_input",
      text: "echo hi",
      resultMeta: {
        kind: "bash",
        status: "completed",
        exit_code: 0,
        stdout: "hi\n",
        stderr: "warn <x>",
      },
    });
  });

  it("leaves plain user messages untouched", () => {
    const records: SessionRecord[] = [
      { type: "user_message", ts: "2026-06-23T00:00:00.000Z", content: "just a prompt" },
    ];
    const entries = sessionRecordsToTranscript(records);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("user");
  });
});
