import { describe, expect, it } from "bun:test";
import {
  lastExecutionId,
  trajectoryStepCount,
  turnIds,
} from "@/engine/providers/antigravity/turn.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("turnIds", () => {
  it("derives a distinct trajectory pair per thread while sessionId stays session-bound", () => {
    const main = turnIds("session-a");
    const fork = turnIds("session-a", "fork-1");
    const sibling = turnIds("session-a", "fork-2");
    expect(fork.conversationId).not.toBe(main.conversationId);
    expect(fork.trajectoryId).not.toBe(main.trajectoryId);
    expect(fork.conversationId).not.toBe(sibling.conversationId);
    expect(fork.sessionId).toBe(main.sessionId);
    expect(sibling.sessionId).toBe(main.sessionId);
  });

  it("is deterministic for the same thread", () => {
    expect(turnIds("session-a", "fork-1")).toEqual(turnIds("session-a", "fork-1"));
    expect(turnIds("session-a")).toEqual(turnIds("session-a"));
  });
});

describe("trajectoryStepCount", () => {
  it("counts user steps and skips functionResponse-only entries", () => {
    const request = {
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ text: "calling tool" }] },
        { role: "user", parts: [{ functionResponse: { name: "read_file", response: {} } }] },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "a", response: {} } },
            { functionResponse: { name: "b", response: {} } },
          ],
        },
        { role: "user", parts: [{ text: "follow-up" }] },
      ],
    };
    expect(trajectoryStepCount(request)).toBe(2);
  });

  it("returns 0 without contents", () => {
    expect(trajectoryStepCount({})).toBe(0);
  });
});

describe("lastExecutionId", () => {
  it("is undefined with no prior model turn", () => {
    expect(
      lastExecutionId("session-a", undefined, { contents: [{ role: "user" }] }),
    ).toBeUndefined();
    expect(
      lastExecutionId("session-a", undefined, {
        contents: [{ role: "user" }, { role: "user" }],
      }),
    ).toBeUndefined();
  });

  it("is a valid uuid once a prior model turn exists", () => {
    const request = { contents: [{ role: "user" }, { role: "model" }, { role: "user" }] };
    const id = lastExecutionId("session-a", undefined, request);
    expect(id).toMatch(UUID_RE);
  });

  it("differs between 1 and 2 completed model turns", () => {
    const oneExecution = { contents: [{ role: "user" }, { role: "model" }, { role: "user" }] };
    const twoExecutions = {
      contents: [
        { role: "user" },
        { role: "model" },
        { role: "user" },
        { role: "model" },
        { role: "user" },
      ],
    };
    const first = lastExecutionId("session-a", undefined, oneExecution);
    const second = lastExecutionId("session-a", undefined, twoExecutions);
    expect(first).not.toBe(second);
  });

  it("is trajectory-scoped — different threadId yields a different id for the same contents", () => {
    const request = { contents: [{ role: "user" }, { role: "model" }, { role: "user" }] };
    const main = lastExecutionId("session-a", undefined, request);
    const fork = lastExecutionId("session-a", "fork-1", request);
    expect(fork).not.toBe(main);
  });

  it("is deterministic for the same inputs", () => {
    const request = { contents: [{ role: "user" }, { role: "model" }, { role: "user" }] };
    expect(lastExecutionId("session-a", "fork-1", request)).toBe(
      lastExecutionId("session-a", "fork-1", request),
    );
  });
});
