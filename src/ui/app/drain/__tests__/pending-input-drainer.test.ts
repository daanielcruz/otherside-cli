import { afterEach, describe, expect, it } from "bun:test";
import type { PendingChange } from "@/commands/index.ts";
import { getQueueMessages, queueActions } from "@/store/index.ts";
import { createPendingInputDrainer } from "@/ui/app/drain/pending-input-drainer.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

afterEach(() => queueActions.clear());

function makeDrainer() {
  const applied: PendingChange[] = [];
  let current: readonly TranscriptEntry[] = [];
  let idCounter = 0;
  const drainer = createPendingInputDrainer({
    applyPendingChange: (c) => applied.push(c),
    setTranscript: (v) => {
      current = typeof v === "function" ? v(current) : v;
    },
    nextTranscriptId: (prefix) => `${prefix}_${idCounter++}`,
  });
  return { drainer, applied, getCurrent: () => current };
}

describe("createPendingInputDrainer", () => {
  it("returns an empty list for an empty queue", () => {
    const { drainer } = makeDrainer();
    expect(drainer()).toEqual([]);
  });

  it("drains plain messages (synthesizing text blocks) and retains slash entries in the queue", () => {
    queueActions.push({ id: "m1", text: "hi", expanded: "hi" });
    queueActions.push({ id: "s1", text: "/help", expanded: "/help" });
    const { drainer } = makeDrainer();
    const drained = drainer();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.text).toBe("hi");
    expect(drained[0]?.blocks).toEqual([{ type: "text", text: "hi" }]);
    expect(getQueueMessages().map((q) => q.expanded)).toEqual(["/help"]);
  });

  it("applies pending changes (with feedback transcript) and excludes them from drained", () => {
    const change = { kind: "set_effort", effort: "high" } as PendingChange;
    queueActions.push({
      id: "c1",
      text: "[QUEUED]",
      expanded: "",
      pendingChange: change,
      changeFeedback: "fb",
    });
    const { drainer, applied, getCurrent } = makeDrainer();
    const drained = drainer();
    expect(applied).toEqual([change]);
    expect(drained).toHaveLength(0);
    expect(getCurrent().some((e) => e.text === "fb")).toBe(true);
  });

  it("preserves caller-provided blocks", () => {
    queueActions.push({
      id: "m1",
      text: "x",
      expanded: "x",
      blocks: [{ type: "text", text: "custom" }],
    });
    const { drainer } = makeDrainer();
    expect(drainer()[0]?.blocks).toEqual([{ type: "text", text: "custom" }]);
  });
});
