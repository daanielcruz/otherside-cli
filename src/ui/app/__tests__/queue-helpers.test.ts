import { describe, expect, it } from "bun:test";
import type { PendingChange } from "@/commands/index.ts";
import { formatQueuedActionLabel } from "@/ui/app/drain/queue.ts";

describe("formatQueuedActionLabel", () => {
  it("describes a set_effort change", () => {
    const label = formatQueuedActionLabel({ kind: "set_effort", effort: "high" } as PendingChange);
    expect(label).toBe("At next turn Otherside will set effort to high");
  });

  it("describes ultracode enable/disable", () => {
    expect(formatQueuedActionLabel({ kind: "set_ultracode", enabled: true } as PendingChange)).toBe(
      "At next turn Otherside will enable ultracode",
    );
    expect(
      formatQueuedActionLabel({ kind: "set_ultracode", enabled: false } as PendingChange),
    ).toBe("At next turn Otherside will disable ultracode");
  });

  it("describes fast-mode enable/disable", () => {
    expect(formatQueuedActionLabel({ kind: "set_fast_mode", enabled: true } as PendingChange)).toBe(
      "At next turn Otherside will enable fast mode",
    );
    expect(
      formatQueuedActionLabel({ kind: "set_fast_mode", enabled: false } as PendingChange),
    ).toBe("At next turn Otherside will disable fast mode");
  });

  it("describes a goal set with its condition", () => {
    const label = formatQueuedActionLabel({
      kind: "set_goal",
      condition: "ship it",
    } as PendingChange);
    expect(label).toBe("At next turn Otherside will set goal: ship it");
  });
});
