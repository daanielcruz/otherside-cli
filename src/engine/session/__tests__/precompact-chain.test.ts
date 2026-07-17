import { describe, expect, it } from "bun:test";
import {
  type PrecompactChainEntry,
  planPrecompactChain,
} from "@/engine/session/transcript/precompact-chain.ts";

describe("planPrecompactChain", () => {
  it("relinks a live preservedMessages sequence", () => {
    const plan = planPrecompactChain(
      [
        entry("old", null, 0),
        entry("keep-head", "old", 1),
        entry("keep-tail", "keep-head", 2),
        boundary(3, {
          preservedMessages: {
            uuids: ["keep-head", "keep-tail"],
            anchorUuid: "boundary",
          },
        }),
        entry("post", "boundary", 4),
      ],
      "post",
      undefined,
    );

    expect(plan.preserve).toBe("live");
    expect(plan.ordered.map((item) => item.uuid)).toEqual([
      "boundary",
      "keep-head",
      "keep-tail",
      "post",
    ]);
    expect(plan.parentOverrides.get("keep-head")).toBe("boundary");
    expect(plan.parentOverrides.get("keep-tail")).toBe("keep-head");
    expect(plan.parentOverrides.get("post")).toBe("keep-tail");
  });

  it("uses the preserved tail when the boundary is the latest line", () => {
    const plan = planPrecompactChain(
      [
        entry("old", null, 0),
        entry("keep-head", "old", 1),
        entry("keep-tail", "keep-head", 2),
        boundary(3, {
          preservedMessages: {
            uuids: ["keep-head", "keep-tail"],
            anchorUuid: "boundary",
          },
        }),
      ],
      "boundary",
      undefined,
    );

    expect(plan.ordered.map((item) => item.uuid)).toEqual(["boundary", "keep-head", "keep-tail"]);
  });

  it("walks and relinks a live preservedSegment", () => {
    const plan = planPrecompactChain(
      [
        entry("old", null, 0),
        entry("keep-head", "old", 1),
        entry("keep-tail", "keep-head", 2),
        boundary(3, {
          preservedSegment: {
            headUuid: "keep-head",
            tailUuid: "keep-tail",
            anchorUuid: "boundary",
          },
        }),
        entry("post", "boundary", 4),
      ],
      "post",
      undefined,
    );

    expect(plan.preserve).toBe("live");
    expect(plan.ordered.map((item) => item.uuid)).toEqual([
      "boundary",
      "keep-head",
      "keep-tail",
      "post",
    ]);
    expect(plan.parentOverrides.get("keep-head")).toBe("boundary");
    expect(plan.parentOverrides.get("post")).toBe("keep-tail");
  });

  it("lets a later hard boundary invalidate stale preserve metadata", () => {
    const plan = planPrecompactChain(
      [
        entry("keep-head", null, 0),
        boundary(1, {
          preservedMessages: { uuids: ["keep-head"], anchorUuid: "boundary" },
        }),
        entry("preserve-post", "boundary", 2),
        boundary(3, undefined, "hard-boundary"),
        entry("hard-post", "hard-boundary", 4),
      ],
      "hard-post",
      undefined,
    );

    expect(plan.preserve).toBe("none");
    expect(plan.ordered.map((item) => item.uuid)).toEqual(["hard-boundary", "hard-post"]);
    expect(plan.boundaryOffset).toBe(3);
  });

  it("ignores a compact marker with no summary", () => {
    const legacyBoundary = boundary(1);
    legacyBoundary.hasCompactionSummary = false;
    const plan = planPrecompactChain(
      [entry("old", null, 0), legacyBoundary, entry("post", "boundary", 2)],
      "post",
      undefined,
    );

    expect(plan.preserve).toBe("none");
    expect(plan.boundaryOffset).toBeNull();
    expect(plan.ordered.map((item) => item.uuid)).toEqual(["old", "boundary", "post"]);
  });

  it("uses the no-op plan when preserved metadata points at another boundary", () => {
    const entries = [
      entry("old", null, 0),
      entry("keep", "old", 1),
      boundary(2, {
        preservedMessages: { uuids: ["keep"], anchorUuid: "wrong-boundary" },
      }),
      entry("post", "boundary", 3),
    ];

    const plan = planPrecompactChain(entries, "post", undefined);

    expect(plan.preserve).toBe("broken");
    expect(plan.ordered).toEqual(entries);
    expect(plan.boundaryOffset).toBeNull();
  });

  it("uses the no-op plan when preserved metadata omits its anchor", () => {
    const entries = [
      entry("old", null, 0),
      entry("keep", "old", 1),
      boundary(2, {
        preservedSegment: { headUuid: "keep", tailUuid: "keep" },
      }),
      entry("post", "boundary", 3),
    ];

    const plan = planPrecompactChain(entries, "post", undefined);

    expect(plan.preserve).toBe("broken");
    expect(plan.ordered).toEqual(entries);
    expect(plan.boundaryOffset).toBeNull();
  });

  it("leaves the transcript untouched when a preserved segment walk is broken", () => {
    const entries = [
      entry("old", null, 0),
      entry("keep-head", "old", 1),
      boundary(2, {
        preservedSegment: {
          headUuid: "keep-head",
          tailUuid: "missing-tail",
          anchorUuid: "boundary",
        },
      }),
      entry("post", "boundary", 3),
    ];

    const plan = planPrecompactChain(entries, "post", undefined);

    expect(plan.preserve).toBe("broken");
    expect(plan.ordered).toEqual(entries);
    expect(plan.parentOverrides.size).toBe(0);
    expect(plan.boundaryOffset).toBeNull();
  });

  it("walks only the selected active branch", () => {
    const plan = planPrecompactChain(
      [
        entry("root", null, 0),
        entry("dead", "root", 1),
        entry("active-one", "root", 2),
        entry("active-two", "active-one", 3),
        entry("newer-dead", "dead", 4),
      ],
      "newer-dead",
      "active-two",
    );

    expect(plan.ordered.map((item) => item.uuid)).toEqual(["root", "active-one", "active-two"]);
  });
});

function entry(uuid: string, parentUuid: string | null, offset: number): PrecompactChainEntry {
  return { uuid, parentUuid, offset, type: "user" };
}

function boundary(
  offset: number,
  compactMetadata?: unknown,
  uuid = "boundary",
): PrecompactChainEntry {
  return {
    uuid,
    parentUuid: null,
    offset,
    type: "system",
    subtype: "compact_boundary",
    ...(compactMetadata === undefined ? {} : { compactMetadata }),
  };
}
