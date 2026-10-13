import { describe, expect, it } from "bun:test";
import {
  CODE_ASSIST_SESSION_ID,
  lastExecutionId,
  lastStepIndex,
  priorModelReplies,
  turnIds,
} from "@/engine/providers/antigravity/turn.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("turnIds", () => {
  it("derives a distinct trajectory pair per thread while naming the root cascade", () => {
    const main = turnIds("session-a");
    const fork = turnIds("session-a", "fork-1");
    const sibling = turnIds("session-a", "fork-2");
    expect(fork.conversationId).not.toBe(main.conversationId);
    expect(fork.trajectoryId).not.toBe(main.trajectoryId);
    expect(fork.conversationId).not.toBe(sibling.conversationId);
    expect(main.rootConversationId).toBe(main.conversationId);
    expect(fork.rootConversationId).toBe(main.conversationId);
    expect(sibling.rootConversationId).toBe(main.conversationId);
    expect(CODE_ASSIST_SESSION_ID).toBe("-3750763034362895579");
  });

  it("is deterministic for the same thread", () => {
    expect(turnIds("session-a", "fork-1")).toEqual(turnIds("session-a", "fork-1"));
    expect(turnIds("session-a")).toEqual(turnIds("session-a"));
  });
});

describe("lastStepIndex and priorModelReplies", () => {
  it("counts every user input, model reply, and each tool response as a step", () => {
    const firstTurn = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    };
    expect(lastStepIndex(firstTurn)).toBe(0);
    expect(priorModelReplies(firstTurn)).toBe(0);

    const afterParallelTools = {
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        {
          role: "model",
          parts: [
            { functionCall: { id: "1", name: "a", args: {} } },
            { functionCall: { id: "2", name: "b", args: {} } },
          ],
        },
        {
          role: "model",
          parts: [
            { functionResponse: { id: "1", name: "a", response: {} } },
            { functionResponse: { id: "2", name: "b", response: {} } },
          ],
        },
      ],
    };
    expect(lastStepIndex(afterParallelTools)).toBe(3);
    expect(priorModelReplies(afterParallelTools)).toBe(1);
  });

  it("returns 0 without contents", () => {
    expect(lastStepIndex({})).toBe(0);
    expect(priorModelReplies({})).toBe(0);
  });
});

describe("lastExecutionId", () => {
  it("is undefined with no prior completed execution", () => {
    expect(
      lastExecutionId("session-a", undefined, { contents: [{ role: "user" }] }),
    ).toBeUndefined();
    expect(
      lastExecutionId("session-a", undefined, {
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          { role: "model", parts: [{ functionCall: { id: "1", name: "a", args: {} } }] },
          { role: "model", parts: [{ functionResponse: { id: "1", name: "a", response: {} } }] },
        ],
      }),
    ).toBeUndefined();
  });

  it("is a valid uuid once a new user input follows a model reply", () => {
    const request = { contents: [{ role: "user" }, { role: "model" }, { role: "user" }] };
    const id = lastExecutionId("session-a", undefined, request);
    expect(id).toMatch(UUID_RE);
  });

  it("differs between 1 and 2 completed executions", () => {
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
