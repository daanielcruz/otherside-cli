import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import { sessionRecordsToMessages } from "../transcript/to-messages.ts";

describe("sessionRecordsToMessages with content_replacement", () => {
  it("replaces raw tool_result content with replacement sentinel when present", () => {
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

    const messages = sessionRecordsToMessages(records);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[0]?.content[0]).toEqual({
      type: "tool_use",
      id: "call-1",
      name: "Read",
      input: { path: "foo.txt" },
    });

    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call-1",
      content: "replaced content sentinel",
    });
  });

  it("retains raw tool_result content if content_replacement is absent", () => {
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

    const messages = sessionRecordsToMessages(records);

    expect(messages).toHaveLength(2);
    expect(messages[1]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call-1",
      content: "original raw tool result content",
    });
  });
});

function notificationAttachment(prompt: string): SessionRecord {
  return {
    type: "attachment",
    ts: "2026-06-23T00:00:00.000Z",
    attachment: { type: "queued_command", prompt, commandMode: "task-notification" },
  };
}

describe("sessionRecordsToMessages task-notification folding", () => {
  it("folds a notification into the trailing string tool_result, not a sibling block", () => {
    const records: SessionRecord[] = [
      {
        type: "tool_call",
        ts: "2026-06-23T00:00:00.000Z",
        call_id: "call-1",
        tool_name: "Bash",
        args: { command: "echo hi" },
      },
      {
        type: "tool_result",
        ts: "2026-06-23T00:00:00.000Z",
        call_id: "call-1",
        result: "hi",
        is_error: false,
      },
      notificationAttachment('<task-notification>done "ok"</task-notification>'),
    ];

    const messages = sessionRecordsToMessages(records);
    const userContent = messages[messages.length - 1]?.content;
    expect(userContent).toHaveLength(1);
    const block = userContent?.[0];
    expect(block?.type).toBe("tool_result");
    const content = block?.type === "tool_result" ? block.content : "";
    expect(typeof content).toBe("string");
    expect(content).toContain("hi\n\n<system-reminder>");
    // Quotes ride raw — no &quot; HTML-escaping.
    expect(content).toContain('done "ok"');
    expect(content).not.toContain("&quot;");
  });

  it("emits a standalone text block when no tool_result precedes the notification", () => {
    const records: SessionRecord[] = [
      {
        type: "assistant_message",
        ts: "2026-06-23T00:00:00.000Z",
        content: "working",
      },
      notificationAttachment("<task-notification>bg done</task-notification>"),
    ];

    const messages = sessionRecordsToMessages(records);
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("user");
    expect(last?.content).toHaveLength(1);
    expect(last?.content[0]?.type).toBe("text");
  });
});

describe("sessionRecordsToMessages compaction_mark boundary check", () => {
  it("a compaction_mark with summary_ref: '' does NOT wipe prior messages and does NOT inject a summary user message", () => {
    const records: SessionRecord[] = [
      {
        type: "user_message",
        ts: "2026-06-23T00:00:00.000Z",
        content: "hello",
      },
      {
        type: "compaction_mark",
        ts: "2026-06-23T00:00:01.000Z",
        summary_ref: "",
        trigger: "auto_failure",
        error: "Some error",
      },
    ];

    const messages = sessionRecordsToMessages(records);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content[0]).toEqual({
      type: "text",
      text: "hello",
    });
  });

  it("a compaction_mark with a real summary_ref still does (existing behavior preserved)", () => {
    const records: SessionRecord[] = [
      {
        type: "user_message",
        ts: "2026-06-23T00:00:00.000Z",
        content: "hello",
      },
      {
        type: "compaction_mark",
        ts: "2026-06-23T00:00:01.000Z",
        summary_ref: "ref-123",
        trigger: "auto",
      },
    ];

    const messages = sessionRecordsToMessages(records);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    const block = messages[0]?.content[0];
    expect(block?.type).toBe("text");
    const text = block?.type === "text" ? block.text : "";
    expect(text).toContain("ref-123");
  });

  it("loads spilled compaction summary text from a pointer", () => {
    const dir = mkdtempSync(join(tmpdir(), "otherside-summary-ref-test-"));
    try {
      const filepath = join(dir, "summary.txt");
      writeFileSync(filepath, "spilled summary text", "utf8");
      const records: SessionRecord[] = [
        {
          type: "compaction_mark",
          ts: "2026-06-23T00:00:01.000Z",
          summary_ref: {
            kind: "spilled_compaction_summary",
            filepath,
            originalSize: 20,
          },
          trigger: "auto",
        },
      ];

      const messages = sessionRecordsToMessages(records);
      const block = messages[0]?.content[0];
      const text = block?.type === "text" ? block.text : "";
      expect(text).toContain("spilled summary text");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not throw when a spilled compaction summary is missing", () => {
    const records: SessionRecord[] = [
      {
        type: "compaction_mark",
        ts: "2026-06-23T00:00:01.000Z",
        summary_ref: {
          kind: "spilled_compaction_summary",
          filepath: join(tmpdir(), "missing-otherside-summary.txt"),
          originalSize: 20,
        },
        trigger: "auto",
      },
    ];

    expect(() => sessionRecordsToMessages(records)).not.toThrow();
  });
});
