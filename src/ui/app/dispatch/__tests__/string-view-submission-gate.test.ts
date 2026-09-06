import { describe, expect, test } from "bun:test";
import { shouldQueueSubmission } from "@/ui/app/dispatch/string-view-dispatch.ts";

describe("string-view submission gate", () => {
  test("queues plain input for the full running lifecycle", () => {
    expect(shouldQueueSubmission("next message", true)).toBe(true);
    expect(shouldQueueSubmission("next message", false)).toBe(false);
  });

  test("queues non-immediate and unknown slash commands while running", () => {
    expect(shouldQueueSubmission("/clear", true)).toBe(true);
    expect(shouldQueueSubmission("/compact", true)).toBe(true);
    expect(shouldQueueSubmission("/unknown", true)).toBe(true);
  });

  test("allows immediate slash commands through while running", () => {
    expect(shouldQueueSubmission("/help", true)).toBe(false);
    expect(shouldQueueSubmission("/model", true)).toBe(false);
    expect(shouldQueueSubmission("/goal status", true)).toBe(false);
  });
});
