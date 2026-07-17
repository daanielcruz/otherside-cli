import { describe, expect, it } from "bun:test";
import { buildAnthropicMessages } from "@/engine/providers/anthropic/translate.ts";
import { recordsFromParsedLine } from "@/engine/session/record/reader.ts";
import type { AssistantMessageRecord, SessionRecord } from "@/engine/session/record/schema.ts";
import { serializeRecord } from "@/engine/session/record/serializers.ts";
import { SessionChain } from "@/engine/session/record/state.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";

const RECORD: AssistantMessageRecord = {
  type: "assistant_message",
  ts: "2026-07-02T12:00:00.000Z",
  content: "hello",
  thinking: "reasoning",
  thinkingSignature: "B".repeat(420),
  provider: "anthropic",
  model: "claude-fable-5",
  producedAccount: "acct-uuid-1",
};

describe("producedAccount persistence round-trip", () => {
  it("survives serialize -> parse -> message assembly", () => {
    const line = serializeRecord(RECORD, new SessionChain(), { sessionId: "s1", cwd: "/tmp" });
    const parsed = recordsFromParsedLine(JSON.parse(line) as Record<string, unknown>);
    const assistant = parsed.find(
      (r): r is AssistantMessageRecord => r.type === "assistant_message",
    );
    expect(assistant?.producedAccount).toBe("acct-uuid-1");

    const messages = sessionRecordsToMessages(parsed);
    const message = messages.find((m) => m.role === "assistant");
    expect(message?.producedAccount).toBe("acct-uuid-1");
    expect(message?.producedBy).toBe("anthropic");
  });

  it("omits producedAccount when the record has none", () => {
    const { producedAccount: _omitted, ...bare } = RECORD;
    const line = serializeRecord(bare, new SessionChain(), { sessionId: "s1", cwd: "/tmp" });
    expect(line.includes("producedAccount")).toBe(false);
    const parsed = recordsFromParsedLine(JSON.parse(line) as Record<string, unknown>);
    const assistant = parsed.find(
      (r): r is AssistantMessageRecord => r.type === "assistant_message",
    );
    expect(assistant?.producedAccount).toBeUndefined();
  });

  it("adds the tool result payload at the line top level", () => {
    const line = serializeRecord(
      {
        type: "tool_result",
        ts: "2026-07-02T12:00:00.000Z",
        call_id: "toolu_1",
        result: { ok: true },
        is_error: false,
      },
      new SessionChain(),
      { sessionId: "s1", cwd: "/tmp" },
    );

    expect(JSON.parse(line)).toMatchObject({ toolUseResult: { ok: true } });
  });

  it("preserves PDF blocks through record serialization, reload, and native translation", () => {
    const records: SessionRecord[] = [
      {
        type: "tool_call",
        ts: "2026-07-02T12:00:00.000Z",
        call_id: "pdf",
        tool_name: "Read",
        args: { file_path: "/tmp/report.pdf" },
      },
      {
        type: "tool_result",
        ts: "2026-07-02T12:00:01.000Z",
        call_id: "pdf",
        result: [
          {
            type: "pdf",
            source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
            filename: "report.pdf",
            pageCount: 1,
            bytes: 3,
          },
        ],
        is_error: false,
      },
    ];
    const chain = new SessionChain();
    const reloaded = records.flatMap((record) =>
      recordsFromParsedLine(
        JSON.parse(serializeRecord(record, chain, { sessionId: "s1", cwd: "/tmp" })) as Record<
          string,
          unknown
        >,
      ),
    );

    const messages = sessionRecordsToMessages(reloaded);
    expect(messages[1]?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "pdf",
        content: [
          {
            type: "pdf",
            source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
            filename: "report.pdf",
            pageCount: 1,
            bytes: 3,
          },
        ],
      },
    ]);
    expect(
      buildAnthropicMessages(messages, {
        provider: "anthropic",
        model: "claude-opus-4-8",
      } as Parameters<typeof buildAnthropicMessages>[1]).out[1]?.content,
    ).toEqual([
      {
        type: "tool_result",
        tool_use_id: "pdf",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
          },
        ],
      },
    ]);
  });
});
