import { describe, expect, it } from "bun:test";
import { Session } from "@/engine/session/record/state.ts";

describe("records[] trimmed after compaction", () => {
  it("drops pre-boundary records, leaves compaction_mark first", () => {
    const session = new Session("trim-test", "/test/cwd");
    session.pushRecord({ type: "user_message", ts: "2026-01-01T00:00:00.000Z", content: "q1" });
    session.pushRecord({
      type: "assistant_message",
      ts: "2026-01-01T00:00:01.000Z",
      content: "a1",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });
    session.pushRecord({ type: "user_message", ts: "2026-01-01T00:00:02.000Z", content: "q2" });
    session.pushRecord({
      type: "assistant_message",
      ts: "2026-01-01T00:00:03.000Z",
      content: "a2",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });
    expect(session.records).toHaveLength(4);

    const SUMMARY =
      "This is a deterministic test summary that is long enough to pass the length gate.";
    session.pushRecord({
      type: "compaction_mark",
      ts: "2026-01-01T00:00:04.000Z",
      summary_ref: SUMMARY,
      trigger: "manual",
      version: 1,
    });

    const compactBoundaryIdx = session.records.findLastIndex((r) => r.type === "compaction_mark");
    if (compactBoundaryIdx > 0) {
      session.records.splice(0, compactBoundaryIdx);
    }

    expect(session.records).toHaveLength(1);
    expect(session.records[0]?.type).toBe("compaction_mark");

    expect(session.records.filter((r) => r.type === "user_message")).toHaveLength(0);
    expect(session.records.filter((r) => r.type === "assistant_message")).toHaveLength(0);

    const mark = session.records[0] as Extract<
      (typeof session.records)[number],
      { type: "compaction_mark" }
    >;
    expect(mark.summary_ref).toBe(SUMMARY);
    expect(mark.trigger).toBe("manual");
  });

  it("messages[] retains the summary after compaction", () => {
    const session = new Session("trim-msg-test", "/test/cwd");
    const SUMMARY = "The user discussed a refactor of the auth module and reviewed three files.";
    session.messages.push(
      { role: "user", content: [{ type: "text", text: "old q1" }] },
      { role: "assistant", content: [{ type: "text", text: "old a1" }] },
      { role: "user", content: [{ type: "text", text: "old q2" }] },
      { role: "assistant", content: [{ type: "text", text: "old a2" }] },
    );
    expect(session.messages).toHaveLength(4);

    const summaryMessage = `This session is being continued from a previous conversation.\n\n${SUMMARY}`;
    session.messages.splice(0, session.messages.length, {
      role: "user",
      content: [{ type: "text", text: summaryMessage }],
    });

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.role).toBe("user");
    const firstText = session.messages[0]?.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    expect(firstText).toContain(SUMMARY);
  });
});
