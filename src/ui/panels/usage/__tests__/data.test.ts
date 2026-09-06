import { describe, expect, it } from "bun:test";
import type { RoutingUsageSnapshot } from "@/engine/session/usage/limits.ts";
import {
  beginUsageLoad,
  blockedRoutingRows,
  failUsageLoad,
  initialUsageTab,
  restartUsageLoad,
  usageTabIndex,
} from "../data";

function snapshot(
  byProvider: RoutingUsageSnapshot["byProvider"],
  byProviderScope: RoutingUsageSnapshot["byProviderScope"] = {},
): RoutingUsageSnapshot {
  return { byProvider, byProviderScope };
}

describe("usage tab identity", () => {
  it("opens /usage on the current provider", () => {
    expect(initialUsageTab("current", "kimi")).toBe("kimi");
    expect(initialUsageTab("current", "codex")).toBe("codex");
  });

  it("keeps the selected provider when credential tabs expand or reorder", () => {
    const selected = initialUsageTab("current", "kimi");
    expect(usageTabIndex([{ id: "general" }, { id: "kimi" }], selected)).toBe(1);
    expect(
      usageTabIndex(
        [
          { id: "general" },
          { id: "anthropic" },
          { id: "antigravity" },
          { id: "codex" },
          { id: "kimi" },
        ],
        selected,
      ),
    ).toBe(4);
  });
});

describe("usage refresh state", () => {
  const loaded = { status: "loaded" as const, data: { windows: ["weekly"] } };

  it("preserves the last payload while restarting and loading", () => {
    const idle = restartUsageLoad(loaded);
    expect(idle).toEqual({ status: "idle", data: loaded.data });
    expect(beginUsageLoad(idle)).toEqual({ status: "loading", data: loaded.data });
  });

  it("preserves the last payload when refresh fails", () => {
    expect(failUsageLoad(loaded, "timeout")).toEqual({
      status: "error",
      data: loaded.data,
      message: "timeout",
    });
  });
});

describe("blockedRoutingRows", () => {
  it("returns no rows when nothing is over threshold", () => {
    expect(blockedRoutingRows(snapshot({}))).toEqual([]);
    expect(
      blockedRoutingRows(
        snapshot({
          xai: {
            trackingStatus: "tracked",
            utilizationPct: 80,
            observedAtEpochMs: 0,
            balanceStatus: "available",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("flags a tracked provider at the block threshold (fully spent)", () => {
    const rows = blockedRoutingRows(
      snapshot({
        xai: {
          trackingStatus: "tracked",
          utilizationPct: 100,
          observedAtEpochMs: 0,
          balanceStatus: "unknown",
        },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("Quota blocks");
    expect(rows[0]?.value).toContain("100%");
  });

  it("explicit available signal keeps a 100% provider unblocked", () => {
    const rows = blockedRoutingRows(
      snapshot({
        xai: {
          trackingStatus: "tracked",
          utilizationPct: 100,
          observedAtEpochMs: 0,
          balanceStatus: "available",
        },
      }),
    );
    expect(rows).toEqual([]);
  });

  it("keeps a near-limit xAI quota visible when balance is still available", () => {
    const rows = blockedRoutingRows(
      snapshot({
        xai: {
          trackingStatus: "tracked",
          utilizationPct: 96,
          observedAtEpochMs: 0,
          balanceStatus: "available",
        },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("Quota warnings");
    expect(rows[0]?.value).toContain("96%");
  });

  it("does not flag a tracked non-xAI provider below 100%", () => {
    const rows = blockedRoutingRows(
      snapshot({
        codex: {
          trackingStatus: "tracked",
          utilizationPct: 99.5,
          observedAtEpochMs: 0,
          balanceStatus: "available",
        },
      }),
    );
    expect(rows).toEqual([]);
  });

  it("flags an exhausted balance regardless of utilization", () => {
    const rows = blockedRoutingRows(
      snapshot({
        minimax: {
          trackingStatus: "unknown",
          observedAtEpochMs: 0,
          balanceStatus: "exhausted",
        },
      }),
    );
    expect(rows[0]?.value).toContain("balance exhausted");
  });

  it("does not block an untracked provider even above the threshold", () => {
    const rows = blockedRoutingRows(
      snapshot({
        deepseek: {
          trackingStatus: "untracked",
          utilizationPct: 99,
          observedAtEpochMs: 0,
          balanceStatus: "available",
        },
      }),
    );
    expect(rows).toEqual([]);
  });
});
