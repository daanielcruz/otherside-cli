import { afterEach, describe, expect, it } from "bun:test";
import { getQueueMessages, queueActions } from "@/store/index.ts";
import { createPendingInputDrainer } from "@/ui/app/drain/pending-input-drainer.ts";

afterEach(() => queueActions.clear());

function makeDrainer() {
  return { drainer: createPendingInputDrainer() };
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
