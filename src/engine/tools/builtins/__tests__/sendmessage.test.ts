import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  clear as clearInboxes,
  dequeue,
  registerAgent,
  registerMainAgent,
} from "@/engine/agents/inbox.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { SendMessage } from "../sendmessage.ts";

const resumeForkWithMessageMock = mock(() =>
  Promise.resolve({ delivered: false, code: "not_resumable", reason: "not resumable" }),
);

mock.module("@/engine/background/subagents/lifecycle.ts", () => ({
  resumeForkWithMessage: resumeForkWithMessageMock,
}));

describe("SendMessage tool", () => {
  beforeEach(() => {
    clearInboxes();
    resumeForkWithMessageMock.mockClear();
  });

  afterEach(() => {
    clearInboxes();
    resumeForkWithMessageMock.mockClear();
  });

  test("attempts delivery without an environment opt-in", async () => {
    const ctx: RequestContext = {
      sessionId: "session-main",
      agentId: undefined,
    } as unknown as RequestContext;
    const result = await SendMessage.run(
      { id: "call-off", name: "SendMessage", input: { to: "worker", message: "hi" } },
      ctx,
    );
    expect(result.is_error).toBeUndefined();
    expect(resumeForkWithMessageMock).toHaveBeenCalledTimes(1);
  });

  test("main ctx (agentId undefined) sending to main or main alias -> refusal", async () => {
    const ctx: RequestContext = {
      sessionId: "session-main",
      agentId: undefined,
    } as unknown as RequestContext;

    registerMainAgent("session-main");

    const call = {
      id: "call-1",
      name: "SendMessage",
      input: { to: "main", message: "hello" },
    };

    const result = await SendMessage.run(call, ctx);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain(
      "SendMessage cannot target the caller itself — the main conversation already sees this turn",
    );

    const callId = {
      id: "call-2",
      name: "SendMessage",
      input: { to: "session-main", message: "hello" },
    };
    const resultId = await SendMessage.run(callId, ctx);
    expect(resultId.is_error).toBe(true);
    expect(String(resultId.content)).toContain(
      "SendMessage cannot target the caller itself — the main conversation already sees this turn",
    );
  });

  test("fork ctx (agentId set) sending to its own id or unique alias -> refusal", async () => {
    const ctx: RequestContext = {
      sessionId: "session-main",
      agentId: "fork-1",
    } as unknown as RequestContext;

    registerAgent("fork-1", "my-unique-alias");

    // sending to own id
    const callId = {
      id: "call-3",
      name: "SendMessage",
      input: { to: "fork-1", message: "hello" },
    };
    const resultId = await SendMessage.run(callId, ctx);
    expect(resultId.is_error).toBe(true);
    expect(String(resultId.content)).toContain(
      "SendMessage cannot target the caller itself — this agent already sees this turn",
    );

    // sending to own alias
    const callAlias = {
      id: "call-4",
      name: "SendMessage",
      input: { to: "my-unique-alias", message: "hello" },
    };
    const resultAlias = await SendMessage.run(callAlias, ctx);
    expect(resultAlias.is_error).toBe(true);
    expect(String(resultAlias.content)).toContain(
      "SendMessage cannot target the caller itself — this agent already sees this turn",
    );
  });

  test("ambiguous recipient returns ambiguous_recipient and NO resume attempt", async () => {
    const ctx: RequestContext = {
      sessionId: "session-main",
      agentId: "fork-caller",
    } as unknown as RequestContext;

    registerAgent("fork-1", "shared-name");
    registerAgent("fork-2", "shared-name");

    const call = {
      id: "call-5",
      name: "SendMessage",
      input: { to: "shared-name", message: "hello" },
    };

    const result = await SendMessage.run(call, ctx);
    expect(result.is_error).toBeUndefined(); // ok format returns JSON content with delivered: false
    const parsed = JSON.parse(String(result.content)) as Record<string, unknown>;
    expect(parsed.delivered).toBe(false);
    expect(parsed.code).toBe("ambiguous_recipient");
    expect(parsed.reason).toContain("claimed by 2 running agents");

    // Assert resumeForkWithMessage was NOT called
    expect(resumeForkWithMessageMock).toHaveBeenCalledTimes(0);
  });

  test("delivered messages carry the correct from field", async () => {
    const ctxMain: RequestContext = {
      sessionId: "session-main",
      agentId: undefined,
    } as unknown as RequestContext;

    registerAgent("fork-target", "target-alias");

    // Main to fork
    const call1 = {
      id: "call-6",
      name: "SendMessage",
      input: { to: "target-alias", message: "from main" },
    };
    const res1 = await SendMessage.run(call1, ctxMain);
    expect(JSON.parse(String(res1.content)).delivered).toBe(true);

    let msg = dequeue("fork-target");
    expect(msg?.message).toBe("from main");
    expect(msg?.from).toBe("main");

    // Fork (with unique alias) to another fork
    const ctxForkWithAlias: RequestContext = {
      sessionId: "session-main",
      agentId: "fork-sender-1",
    } as unknown as RequestContext;
    registerAgent("fork-sender-1", "sender-alias-1");

    const call2 = {
      id: "call-7",
      name: "SendMessage",
      input: { to: "target-alias", message: "from fork with alias" },
    };
    const res2 = await SendMessage.run(call2, ctxForkWithAlias);
    expect(JSON.parse(String(res2.content)).delivered).toBe(true);

    msg = dequeue("fork-target");
    expect(msg?.message).toBe("from fork with alias");
    expect(msg?.from).toBe("sender-alias-1");

    // Fork (without unique alias) to another fork
    const ctxForkNoAlias: RequestContext = {
      sessionId: "session-main",
      agentId: "fork-sender-2",
    } as unknown as RequestContext;
    registerAgent("fork-sender-2"); // no alias

    const call3 = {
      id: "call-8",
      name: "SendMessage",
      input: { to: "target-alias", message: "from fork no alias" },
    };
    const res3 = await SendMessage.run(call3, ctxForkNoAlias);
    expect(JSON.parse(String(res3.content)).delivered).toBe(true);

    msg = dequeue("fork-target");
    expect(msg?.message).toBe("from fork no alias");
    expect(msg?.from).toBe("fork-sender-2");
  });
});
