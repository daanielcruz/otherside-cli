import { afterEach, describe, expect, it } from "bun:test";
import { getQueueMessages, queueActions } from "@/store/index.ts";
import { createPostTurnDrain } from "@/ui/app/drain/post-turn.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

afterEach(() => queueActions.clear());

function makeDrain() {
  let current: readonly TranscriptEntry[] = [];
  const drain = createPostTurnDrain({
    setTranscript: (v) => {
      current = typeof v === "function" ? v(current) : v;
    },
  });
  return { drain, getCurrent: () => current };
}

describe("createPostTurnDrain", () => {
  it("returns a null continuation for an empty queue", () => {
    const { drain } = makeDrain();
    expect(drain()).toEqual({ nextText: null, nextSuppress: false, nextRestoreEntryId: undefined });
  });

  it("drains a single message into the continuation + a user transcript entry", () => {
    queueActions.push({ id: "q1", text: "hello", expanded: "hello" });
    const { drain, getCurrent } = makeDrain();
    const cont = drain();
    expect(cont.nextText).toBe("hello");
    expect(cont.nextSuppress).toBe(true);
    expect(cont.nextRestoreEntryId).toBeDefined();
    expect(getCurrent().some((e) => e.kind === "user" && e.text === "hello")).toBe(true);
    expect(getQueueMessages()).toHaveLength(0);
  });

  it("prioritizes a message over a slash and re-queues the slash", () => {
    queueActions.push({ id: "qs", text: "/help", expanded: "/help" });
    queueActions.push({ id: "qm", text: "do it", expanded: "do it" });
    const { drain } = makeDrain();
    const cont = drain();
    expect(cont.nextText).toBe("do it");
    expect(getQueueMessages().map((q) => q.expanded)).toEqual(["/help"]);
  });

  it("drains a lone slash as the continuation", () => {
    queueActions.push({ id: "qs", text: "/clear", expanded: "/clear" });
    const { drain } = makeDrain();
    const cont = drain();
    expect(cont.nextText).toBe("/clear");
    expect(cont.nextSuppress).toBe(true);
  });
});
