import { describe, expect, it } from "bun:test";
import { Session } from "@/engine/session/record/state.ts";
import {
  ARCHIVE_NOTICE_OPEN,
  createToolOutputArchive,
} from "@/engine/tool-output-archive/index.ts";
import { pruneToolOutputArchiveForSession } from "../compact/tool-output-archive-prune.ts";

describe("pruneToolOutputArchiveForSession", () => {
  it("drops archive entries no longer referenced by active messages", () => {
    const session = new Session("session-1", "/example/project");
    const archive = createToolOutputArchive();
    archive.observedCallIds.add("old-call");
    archive.observedCallIds.add("active-call");
    archive.notices.set("old-call", "old replacement");
    archive.notices.set("active-call", "active replacement");
    session.toolOutputArchive = archive;
    session.messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "active-call",
          content: "active replacement",
        },
      ],
    });
    session.pushRecord({
      type: "content_replacement",
      ts: "2026-01-01T00:00:00.000Z",
      kind: "tool-result",
      toolUseId: "active-call",
      replacement: "active replacement",
    });

    pruneToolOutputArchiveForSession(session);

    expect(session.toolOutputArchive?.observedCallIds.has("old-call")).toBe(false);
    expect(session.toolOutputArchive?.observedCallIds.has("active-call")).toBe(true);
    expect(session.toolOutputArchive?.notices.has("old-call")).toBe(false);
    expect(session.toolOutputArchive?.notices.get("active-call")).toBe("active replacement");
  });

  it("drops compacted and unreferenced entries while keeping live candidates", () => {
    const session = new Session("session-1", "/example/project");
    const archive = createToolOutputArchive();
    archive.observedCallIds.add("old-call");
    archive.observedCallIds.add("compacted-call");
    archive.observedCallIds.add("live-call");
    archive.notices.set("old-call", "old replacement");
    archive.notices.set("compacted-call", `${ARCHIVE_NOTICE_OPEN} stored`);
    session.toolOutputArchive = archive;
    session.messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "compacted-call",
          content: `${ARCHIVE_NOTICE_OPEN} stored`,
        },
        { type: "tool_result", tool_use_id: "live-call", content: "raw output" },
      ],
    });

    pruneToolOutputArchiveForSession(session);

    const next = session.toolOutputArchive;
    expect(next?.observedCallIds.has("old-call")).toBe(false);
    expect(next?.notices.has("old-call")).toBe(false);
    expect(next?.observedCallIds.has("compacted-call")).toBe(false);
    expect(next?.notices.has("compacted-call")).toBe(false);
    expect(next?.observedCallIds.has("live-call")).toBe(true);
  });

  it("retains an inherited notice for a live candidate without a record", () => {
    const session = new Session("session-1", "/example/project");
    const archive = createToolOutputArchive();
    archive.notices.set("live-call", "inherited replacement");
    session.toolOutputArchive = archive;
    session.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "live-call", content: "raw output" }],
    });

    pruneToolOutputArchiveForSession(session);

    expect(session.toolOutputArchive?.notices.get("live-call")).toBe("inherited replacement");
  });
});
