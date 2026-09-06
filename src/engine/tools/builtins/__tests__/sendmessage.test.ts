import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  clear as clearInboxes,
  dequeue,
  registerAgent,
  registerMainAgent,
} from "@/engine/agents/inbox.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { SendMessage } from "../sendmessage.ts";

type ResumeResult =
  | { delivered: true; agentId: string; resumed: boolean; warning?: string }
  | { delivered: false; code: string; reason: string };

const resumeForkWithMessageMock = mock(
  (
    _to: string,
    _prompt: string,
    _ctx?: RequestContext,
    _route?: { provider: string; model: string },
  ): Promise<ResumeResult> =>
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

  test("fork ctx (agentId set) sending to its own id -> refusal", async () => {
    const ctx: RequestContext = {
      sessionId: "session-main",
      agentId: "fork-1",
    } as unknown as RequestContext;

    registerAgent("fork-1");

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
  });

  // Addressing is id-only: a label that is not an id never routes to a running
  // agent — delivery falls through to the resume path, which reports the
  // unknown recipient with the registered ids.
  test("a name-style label is not an address — the id is required", async () => {
    const ctx: RequestContext = {
      sessionId: "session-main",
      agentId: "fork-caller",
    } as unknown as RequestContext;

    registerAgent("fork-1");

    const call = {
      id: "call-5",
      name: "SendMessage",
      input: { to: "some-agent-name", message: "hello" },
    };

    const result = await SendMessage.run(call, ctx);
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(String(result.content)) as Record<string, unknown>;
    expect(parsed.delivered).toBe(false);
    expect(resumeForkWithMessageMock).toHaveBeenCalledTimes(1);
  });

  test("delivered messages carry the correct from field", async () => {
    const ctxMain: RequestContext = {
      sessionId: "session-main",
      agentId: undefined,
    } as unknown as RequestContext;

    registerAgent("fork-target");

    // Main to fork
    const call1 = {
      id: "call-6",
      name: "SendMessage",
      input: { to: "fork-target", message: "from main" },
    };
    const res1 = await SendMessage.run(call1, ctxMain);
    expect(JSON.parse(String(res1.content)).delivered).toBe(true);

    let msg = dequeue("fork-target");
    expect(msg?.message).toBe("from main");
    expect(msg?.from).toBe("main");

    // Fork to another fork: the sender is named by its id.
    const ctxFork: RequestContext = {
      sessionId: "session-main",
      agentId: "fork-sender-2",
    } as unknown as RequestContext;
    registerAgent("fork-sender-2");

    const call3 = {
      id: "call-8",
      name: "SendMessage",
      input: { to: "fork-target", message: "from fork" },
    };
    const res3 = await SendMessage.run(call3, ctxFork);
    expect(JSON.parse(String(res3.content)).delivered).toBe(true);

    msg = dequeue("fork-target");
    expect(msg?.message).toBe("from fork");
    expect(msg?.from).toBe("fork-sender-2");
  });

  test("a routing pair skips the inbox fast path and rides the resume call", async () => {
    const ctx: RequestContext = {
      sessionId: "session-main",
      agentId: undefined,
    } as unknown as RequestContext;
    registerAgent("fork-routed");
    resumeForkWithMessageMock.mockImplementationOnce(() =>
      Promise.resolve({ delivered: true, agentId: "fork-routed", resumed: true }),
    );

    const result = await SendMessage.run(
      {
        id: "call-routing",
        name: "SendMessage",
        input: {
          to: "fork-routed",
          message: "switch and continue",
          routing: { provider: "codex", model: "gpt-5.5" },
        },
      },
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(resumeForkWithMessageMock).toHaveBeenCalledTimes(1);
    expect(resumeForkWithMessageMock.mock.calls[0]?.[3]).toEqual({
      provider: "codex",
      model: "gpt-5.5",
    });
    // The inbox was never used, so nothing is sitting in the target's queue.
    expect(dequeue("fork-routed")).toBeNull();
  });

  test("a same-model routing no-op returns its warning in the tool result", async () => {
    const ctx: RequestContext = {
      sessionId: "session-main",
      agentId: undefined,
    } as unknown as RequestContext;
    registerAgent("fork-noop");
    const warning =
      "routing ignored: agent fork-noop already runs codex/gpt-5.5. Omit `routing` unless the agent must move to a different provider/model.";
    resumeForkWithMessageMock.mockImplementationOnce(() =>
      Promise.resolve({ delivered: true, agentId: "fork-noop", resumed: false, warning }),
    );

    const result = await SendMessage.run(
      {
        id: "call-noop",
        name: "SendMessage",
        input: {
          to: "fork-noop",
          message: "keep going",
          routing: { provider: "codex", model: "gpt-5.5" },
        },
      },
      ctx,
    );

    const parsed = JSON.parse(String(result.content)) as Record<string, unknown>;
    expect(parsed.delivered).toBe(true);
    expect(parsed.warning).toBe(warning);
  });

  test("a half-filled routing field is rejected before any delivery", async () => {
    const ctx: RequestContext = {
      sessionId: "session-main",
      agentId: undefined,
    } as unknown as RequestContext;
    registerAgent("fork-partial");

    const result = await SendMessage.run(
      {
        id: "call-partial",
        name: "SendMessage",
        input: { to: "fork-partial", message: "hi", routing: { model: "gpt-5.5" } },
      },
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("{provider, model} pair");
    expect(resumeForkWithMessageMock).toHaveBeenCalledTimes(0);
    expect(dequeue("fork-partial")).toBeNull();
  });
});
