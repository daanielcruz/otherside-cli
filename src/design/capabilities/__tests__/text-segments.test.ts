import { describe, expect, it } from "bun:test";
import {
  appendDesignText,
  beginDesignTextSegments,
  clearDesignTextSegments,
  currentDesignTextSegment,
  flushDesignText,
  setDesignTurnIndex,
} from "@/design/tool-cards.ts";
import type { DesignSnapshot, RpcContext } from "@/design/types.ts";

function makeSnapshot(designId: string): DesignSnapshot {
  return {
    designId,
    messages: [],
    files: [],
    artifacts: [],
    viewState: { activeFileTab: null, openFiles: [], activeChatId: null },
    designSystem: { designSystemId: "default", isDefault: true },
    status: "streaming",
    updatedAt: new Date().toISOString(),
  };
}

// flushDesignText only reaches for ctx.snapshots; the rest of RpcContext is
// irrelevant to the segment bookkeeping under test.
function makeCtx(designId: string): RpcContext {
  const snapshots = new Map<string, DesignSnapshot>();
  snapshots.set(designId, makeSnapshot(designId));
  return { snapshots } as unknown as RpcContext;
}

describe("design text segments", () => {
  it("persists a non-empty pre-tool segment and advances the index", () => {
    const designId = "d-seg-1";
    setDesignTurnIndex(designId, 2);
    beginDesignTextSegments(designId);
    const ctx = makeCtx(designId);

    appendDesignText(designId, "I'll make ");
    appendDesignText(designId, "two edits");
    expect(currentDesignTextSegment(designId)).toBe(0);

    flushDesignText(ctx, designId);

    const messages = ctx.snapshots.get(designId)?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("I'll make two edits");
    expect(messages[0]?.segment).toBe(0);
    expect(messages[0]?.turnIndex).toBe(2);
    expect(currentDesignTextSegment(designId)).toBe(1);

    clearDesignTextSegments(designId);
  });

  it("does not advance or persist on a whitespace-only buffer (back-to-back tools)", () => {
    const designId = "d-seg-2";
    setDesignTurnIndex(designId, 0);
    beginDesignTextSegments(designId);
    const ctx = makeCtx(designId);

    appendDesignText(designId, "text");
    flushDesignText(ctx, designId); // segment 0 → persisted, index → 1
    flushDesignText(ctx, designId); // empty buffer → no-op

    const messages = ctx.snapshots.get(designId)?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(currentDesignTextSegment(designId)).toBe(1);

    clearDesignTextSegments(designId);
  });

  it("reports segment 0 for an unknown design", () => {
    expect(currentDesignTextSegment("never-started")).toBe(0);
  });
});
