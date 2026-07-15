import { afterEach, describe, expect, test } from "bun:test";
import {
  agentDisplayName,
  clear,
  dequeue,
  enqueue,
  registerAgent,
  registerMainAgent,
  resolveAgentId,
} from "../inbox.ts";

afterEach(() => clear());

describe("agent inbox addressing", () => {
  test("routes the reserved main alias and the session id to the same inbox", () => {
    registerMainAgent("session-1");

    expect(enqueue("main", "from alias")).toMatchObject({
      delivered: true,
      agentId: "session-1",
    });
    expect(enqueue("session-1", "from id")).toMatchObject({
      delivered: true,
      agentId: "session-1",
    });
    expect(dequeue("session-1")?.message).toBe("from alias");
    expect(dequeue("session-1")?.message).toBe("from id");
  });

  test("prevents spawned agents from claiming the main alias", () => {
    expect(() => registerAgent("worker-1", "main")).toThrow(
      'agent name "main" is reserved for the main conversation',
    );
    expect(resolveAgentId("worker-1")).toBeNull();
  });

  test("delivers running-agent messages through its turn-boundary handler", () => {
    const delivered: string[] = [];
    const unregister = registerAgent("worker-1", "worker", (message) => {
      delivered.push(message.message);
    });

    expect(enqueue("worker", "steer now")).toMatchObject({
      delivered: true,
      agentId: "worker-1",
    });
    expect(delivered).toEqual(["steer now"]);

    unregister();
    expect(enqueue("worker", "too late")).toMatchObject({
      delivered: false,
      code: "unknown_recipient",
    });
  });

  test("two registerAgent claims on one name results in ambiguous_recipient, and unregistering one resolves it", () => {
    const unregister1 = registerAgent("worker-1", "worker-alias");
    const unregister2 = registerAgent("worker-2", "worker-alias");

    const result = enqueue("worker-alias", "hello");
    expect(result).toEqual({
      delivered: false,
      code: "ambiguous_recipient",
      reason:
        'name "worker-alias" is claimed by 2 running agents: worker-1, worker-2 — address one by its id',
    });

    unregister1();

    const result2 = enqueue("worker-alias", "hello again");
    expect(result2).toMatchObject({
      delivered: true,
      agentId: "worker-2",
    });

    const msg = dequeue("worker-2");
    expect(msg?.message).toBe("hello again");

    unregister2();
  });

  test("from field round-trips through enqueue/dequeue", () => {
    registerAgent("worker-3", "worker-3-alias");
    const result = enqueue("worker-3", "hello", undefined, "sender-1");
    expect(result.delivered).toBe(true);

    const msg = dequeue("worker-3");
    expect(msg?.from).toBe("sender-1");
  });

  test("agentDisplayName returns the alias for a single-claimant id and null otherwise", () => {
    // Single claimant
    const unregister1 = registerAgent("worker-4", "worker-4-alias");
    expect(agentDisplayName("worker-4")).toBe("worker-4-alias");

    // Multiple claimant on same alias
    const unregister2 = registerAgent("worker-5", "worker-4-alias");
    expect(agentDisplayName("worker-4")).toBeNull();
    expect(agentDisplayName("worker-5")).toBeNull();

    unregister1();
    unregister2();
  });
});
