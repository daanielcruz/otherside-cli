import { describe, expect, it } from "bun:test";
import { snapshotMessages } from "@/design/capabilities/llm-stream.ts";
import type { DesignSnapshot, DesignSnapshotMessage } from "@/design/types.ts";

function makeSnapshot(messages: DesignSnapshotMessage[]): DesignSnapshot {
  return {
    designId: "design-1",
    messages,
    files: [],
    artifacts: [],
    viewState: { activeFileTab: null, openFiles: [], activeChatId: null },
    designSystem: { designSystemId: "default", isDefault: true },
    status: "completed",
    updatedAt: new Date().toISOString(),
  };
}

describe("snapshotMessages — client-supplied identity", () => {
  it("matches by client-supplied id, winning over the index/content fallback", () => {
    const existing = makeSnapshot([
      {
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: "2024-01-01T00:00:00.000Z",
        source: "left",
        status: "done",
      },
      {
        id: "m2",
        role: "user",
        content: "hello",
        createdAt: "2024-01-02T00:00:00.000Z",
        source: "left",
        status: "done",
      },
    ]);
    // Index/content fallback would pick existing[0] ("m1"); the id must win.
    const result = snapshotMessages([{ role: "user", content: "hello", id: "m2" }], existing);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("m2");
    expect(result[0]?.createdAt).toBe("2024-01-02T00:00:00.000Z");
  });

  it("uses the client-supplied createdAt when present", () => {
    const result = snapshotMessages([
      { role: "user", content: "hi", id: "m1", createdAt: "2030-05-05T05:05:05.000Z" },
    ]);
    expect(result[0]?.id).toBe("m1");
    expect(result[0]?.createdAt).toBe("2030-05-05T05:05:05.000Z");
  });

  it("assigns strictly monotonic fallback timestamps when the client omits createdAt", () => {
    const result = snapshotMessages([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ]);
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.id)).toEqual([
      "design-message-0",
      "design-message-1",
      "design-message-2",
    ]);
    const times = result.map((m) => new Date(m.createdAt).getTime());
    expect(times[1]).toBeGreaterThan(times[0] ?? Number.NaN);
    expect(times[2]).toBeGreaterThan(times[1] ?? Number.NaN);
  });

  it("still matches by index/content when the client sends no ids", () => {
    const existing = makeSnapshot([
      {
        id: "original-id",
        role: "user",
        content: "hello",
        createdAt: "2024-01-01T00:00:00.000Z",
        source: "left",
        status: "done",
      },
    ]);
    const result = snapshotMessages([{ role: "user", content: "hello" }], existing);
    expect(result[0]?.id).toBe("original-id");
    expect(result[0]?.createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("re-attaches interim text segments the client never echoes, sorted by time", () => {
    // The client sends the user prompt and the final assistant text; the interim
    // segment (prose that ran before a tool) is CLI-authored and absent from the
    // client list — it must survive the rebuild and land between the two.
    const existing = makeSnapshot([
      {
        id: "u1",
        role: "user",
        content: "make it",
        createdAt: "2024-01-01T00:00:00.000Z",
        source: "left",
        status: "done",
        turnIndex: 0,
      },
      {
        id: "design-assistant-d1-t0-s0",
        role: "assistant",
        content: "I'll make two edits",
        createdAt: "2024-01-01T00:00:01.000Z",
        source: "left",
        status: "done",
        turnIndex: 0,
        segment: 0,
      },
      {
        id: "final",
        role: "assistant",
        content: "Done.",
        createdAt: "2024-01-01T00:00:02.000Z",
        source: "left",
        status: "done",
        turnIndex: 0,
      },
    ]);
    const result = snapshotMessages(
      [
        { role: "user", content: "make it", id: "u1" },
        { role: "assistant", content: "Done.", id: "final" },
      ],
      existing,
    );
    expect(result.map((m) => m.content)).toEqual(["make it", "I'll make two edits", "Done."]);
    expect(result[1]?.segment).toBe(0);
  });

  it("returns the mapped list unchanged when no interim segments exist", () => {
    const existing = makeSnapshot([
      {
        id: "u1",
        role: "user",
        content: "hi",
        createdAt: "2024-01-01T00:00:00.000Z",
        source: "left",
        status: "done",
      },
    ]);
    const result = snapshotMessages([{ role: "user", content: "hi", id: "u1" }], existing);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("u1");
  });
});
