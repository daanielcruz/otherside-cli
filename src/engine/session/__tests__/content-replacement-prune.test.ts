import { describe, expect, it } from "bun:test";
import { Session } from "@/engine/session/record/state.ts";
import {
  createContentReplacementState,
  PERSISTED_OUTPUT_TAG,
} from "@/engine/tool-result-storage/index.ts";
import { pruneContentReplacementStateForSession } from "../compact/content-replacement-prune.ts";

describe("pruneContentReplacementStateForSession", () => {
  it("drops replacement entries no longer referenced by active messages", () => {
    const session = new Session("session-1", "/tmp/project");
    const state = createContentReplacementState();
    state.seenIds.add("old-call");
    state.seenIds.add("active-call");
    state.replacements.set("old-call", "old replacement");
    state.replacements.set("active-call", "active replacement");
    session.contentReplacementState = state;
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

    pruneContentReplacementStateForSession(session);

    expect(session.contentReplacementState?.seenIds.has("old-call")).toBe(false);
    expect(session.contentReplacementState?.seenIds.has("active-call")).toBe(true);
    expect(session.contentReplacementState?.replacements.has("old-call")).toBe(false);
    expect(session.contentReplacementState?.replacements.get("active-call")).toBe(
      "active replacement",
    );
  });

  it("drops already-compacted and unreferenced entries, keeping live non-compacted candidates", () => {
    const session = new Session("session-1", "/tmp/project");
    const state = createContentReplacementState();
    state.seenIds.add("old-call");
    state.seenIds.add("compacted-call");
    state.seenIds.add("live-call");
    state.replacements.set("old-call", "old replacement");
    state.replacements.set("compacted-call", `${PERSISTED_OUTPUT_TAG} stored`);
    session.contentReplacementState = state;
    session.messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "compacted-call",
          content: `${PERSISTED_OUTPUT_TAG} stored`,
        },
        { type: "tool_result", tool_use_id: "live-call", content: "raw output" },
      ],
    });

    pruneContentReplacementStateForSession(session);

    const next = session.contentReplacementState;
    expect(next?.seenIds.has("old-call")).toBe(false);
    expect(next?.replacements.has("old-call")).toBe(false);
    // already-compacted tool_results are filtered out as non-candidates → dropped
    expect(next?.seenIds.has("compacted-call")).toBe(false);
    expect(next?.replacements.has("compacted-call")).toBe(false);
    expect(next?.seenIds.has("live-call")).toBe(true);
  });

  it("retains an inherited replacement for a live candidate without a record", () => {
    const session = new Session("session-1", "/tmp/project");
    const state = createContentReplacementState();
    state.replacements.set("live-call", "inherited replacement");
    session.contentReplacementState = state;
    session.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "live-call", content: "raw output" }],
    });

    pruneContentReplacementStateForSession(session);

    expect(session.contentReplacementState?.replacements.get("live-call")).toBe(
      "inherited replacement",
    );
  });
});
