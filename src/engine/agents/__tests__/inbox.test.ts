import { afterEach, describe, expect, test } from "bun:test";
import {
  addressedMessageText,
  clear,
  dequeue,
  enqueue,
  registerAgent,
  registerMainAgent,
  resolveAgentId,
} from "../inbox.ts";

afterEach(() => clear());

describe("agent inbox addressing", () => {
  test("routes the reserved main address and the session id to the same inbox", () => {
    registerMainAgent("session-1");

    expect(enqueue("main", "from address")).toMatchObject({
      delivered: true,
      agentId: "session-1",
    });
    expect(enqueue("session-1", "from id")).toMatchObject({
      delivered: true,
      agentId: "session-1",
    });
    expect(dequeue("session-1")?.message).toBe("from address");
    expect(dequeue("session-1")?.message).toBe("from id");
  });

  test("delivers running-agent messages through its turn-boundary handler", () => {
    const delivered: string[] = [];
    const unregister = registerAgent("worker-1", (message) => {
      delivered.push(message.message);
    });

    expect(enqueue("worker-1", "steer now")).toMatchObject({
      delivered: true,
      agentId: "worker-1",
    });
    expect(delivered).toEqual(["steer now"]);

    unregister();
    expect(enqueue("worker-1", "too late")).toMatchObject({
      delivered: false,
      code: "unknown_recipient",
    });
  });

  // Addressing is id-only: a label that is not a registered id never routes.
  test("rejects any recipient that is not a registered id", () => {
    registerAgent("worker-1");
    expect(resolveAgentId("worker-1")).toBe("worker-1");
    expect(resolveAgentId("worker-alias")).toBeNull();
    expect(enqueue("worker-alias", "hello")).toMatchObject({
      delivered: false,
      code: "unknown_recipient",
    });
  });

  test("from field round-trips through enqueue/dequeue", () => {
    registerAgent("worker-3");
    const result = enqueue("worker-3", "hello", undefined, "sender-1");
    expect(result.delivered).toBe(true);

    const msg = dequeue("worker-3");
    expect(msg?.from).toBe("sender-1");
  });
});

describe("addressedMessageText", () => {
  test("leads with the sender so the agent knows who to answer", () => {
    expect(addressedMessageText({ message: "ship it", from: "main" })).toBe("[From main]\nship it");
  });

  test("names both the sender and what it answers", () => {
    expect(addressedMessageText({ message: "done", from: "reviewer", replyTo: "msg-1" })).toBe(
      "[From reviewer · Reply to msg-1]\ndone",
    );
  });

  test("adds nothing when the message is addressed by neither", () => {
    expect(addressedMessageText({ message: "plain" })).toBe("plain");
  });
});
