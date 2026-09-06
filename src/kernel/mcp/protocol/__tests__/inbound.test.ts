import { afterEach, describe, expect, test } from "bun:test";
import {
  answerInbound,
  clearInboundResponders,
  clearInboundWatchers,
  deliverInboundNotice,
  type InboundRequest,
  isInboundNotice,
  isInboundRequest,
  METHOD_NOT_FOUND,
  registerInboundResponder,
  replyToInbound,
  watchInboundNotice,
} from "@/kernel/mcp/protocol/inbound.ts";

afterEach(() => {
  clearInboundResponders();
  clearInboundWatchers();
});

function asked(over: Partial<InboundRequest> = {}): InboundRequest {
  return {
    server: "probe",
    method: "elicitation/create",
    params: { message: "May I?" },
    signal: new AbortController().signal,
    ...over,
  };
}

describe("telling a request from a reply", () => {
  test("a message with both a method and an id is the server asking", () => {
    expect(isInboundRequest({ jsonrpc: "2.0", id: 7, method: "elicitation/create" })).toBe(true);
    expect(isInboundRequest({ jsonrpc: "2.0", id: "abc", method: "ping" })).toBe(true);
  });

  test("a reply and a notification are not", () => {
    // A reply carries an id and no method; a notification carries a method and no id.
    expect(isInboundRequest({ jsonrpc: "2.0", id: 7, result: {} })).toBe(false);
    expect(isInboundRequest({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(false);
    expect(isInboundRequest(null)).toBe(false);
  });
});

describe("what the server hears back", () => {
  test("the responder's answer, when one serves the method", async () => {
    registerInboundResponder("elicitation/create", async () => ({ action: "accept" }));
    expect(await answerInbound(asked())).toEqual({ result: { action: "accept" } });
  });

  test("a method nobody serves is answered, not ignored", async () => {
    // Silence is the failure this exists to prevent: the server would wait on a
    // reply that is never coming.
    const answer = await answerInbound(asked({ method: "sampling/createMessage" }));
    expect(answer.error?.code).toBe(METHOD_NOT_FOUND);
    expect(answer.error?.message).toContain("sampling/createMessage");
  });

  test("a responder that throws answers with the failure rather than nothing", async () => {
    registerInboundResponder("elicitation/create", async () => {
      throw new Error("the prompt could not open");
    });
    const answer = await answerInbound(asked());
    expect(answer.result).toBeUndefined();
    expect(answer.error?.message).toBe("the prompt could not open");
  });

  test("tearing a responder down puts the method back to unserved", async () => {
    const stop = registerInboundResponder("elicitation/create", async () => ({ action: "accept" }));
    stop();
    expect((await answerInbound(asked())).error?.code).toBe(METHOD_NOT_FOUND);
  });
});

describe("the reply a transport writes", () => {
  test("carries the request's id so the server can match it", async () => {
    registerInboundResponder("elicitation/create", async () => ({ action: "decline" }));
    const written: object[] = [];
    await replyToInbound({
      message: { id: 42, method: "elicitation/create", params: {} },
      server: "probe",
      signal: new AbortController().signal,
      send: (reply) => written.push(reply),
    });

    expect(written).toEqual([{ jsonrpc: "2.0", id: 42, result: { action: "decline" } }]);
  });

  test("is written even when nothing serves the method", async () => {
    const written: object[] = [];
    await replyToInbound({
      message: { id: "x1", method: "roots/list" },
      server: "probe",
      signal: new AbortController().signal,
      send: (reply) => written.push(reply),
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ id: "x1", error: { code: METHOD_NOT_FOUND } });
  });
});

describe("what a server tells us unasked", () => {
  test("a method with no id is a notice, not a request", () => {
    expect(isInboundNotice({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })).toBe(
      true,
    );
    expect(isInboundNotice({ jsonrpc: "2.0", id: 4, method: "elicitation/create" })).toBe(false);
    expect(isInboundNotice({ jsonrpc: "2.0", id: 4, result: {} })).toBe(false);
  });

  test("reaches everyone watching that method, with the server that sent it", () => {
    const heard: string[] = [];
    watchInboundNotice("notifications/tools/list_changed", (notice) => heard.push(notice.server));
    watchInboundNotice("notifications/tools/list_changed", () => heard.push("second"));

    deliverInboundNotice({
      server: "probe",
      method: "notifications/tools/list_changed",
      params: {},
    });
    expect(heard).toEqual(["probe", "second"]);
  });

  test("a method nobody watches is not an error", () => {
    expect(() => {
      deliverInboundNotice({ server: "probe", method: "notifications/message", params: {} });
    }).not.toThrow();
  });

  test("one watcher throwing does not cost the others their notice", () => {
    const heard: string[] = [];
    watchInboundNotice("notifications/tools/list_changed", () => {
      throw new Error("watcher failed");
    });
    watchInboundNotice("notifications/tools/list_changed", () => heard.push("still heard"));

    deliverInboundNotice({
      server: "probe",
      method: "notifications/tools/list_changed",
      params: {},
    });
    expect(heard).toEqual(["still heard"]);
  });

  test("a watcher torn down hears nothing more", () => {
    const heard: string[] = [];
    const stop = watchInboundNotice("notifications/tools/list_changed", () => heard.push("heard"));
    stop();

    deliverInboundNotice({
      server: "probe",
      method: "notifications/tools/list_changed",
      params: {},
    });
    expect(heard).toEqual([]);
  });
});
