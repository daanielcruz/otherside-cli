import { beforeEach, describe, expect, test } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";

beforeEach(() => {
  emitQueue._resetForTests();
});

describe("projection", () => {
  test("T18 target=both produces parallel llmBlocks + transcriptEntries in one drain", () => {
    emitQueue.emit({
      class: "deferred_output",
      target: "both",
      payload: {
        kind: "task_notification_xml",
        text: "<task-notification>hi</task-notification>",
        summary: "hi",
      },
    });
    const result = emitQueue.drainForBoundary("turn_start");
    expect(result.llmBlocks.length).toBeGreaterThan(0);
    expect(result.transcriptEntries.length).toBe(1);
  });
});
