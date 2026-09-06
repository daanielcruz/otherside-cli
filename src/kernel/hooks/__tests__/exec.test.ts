import { describe, expect, it, spyOn } from "bun:test";
import { normalizeHooksConfig } from "@/kernel/config/config.ts";
import { _resetAgentHookRunnersForTests, fireEntry, registerAgentHookRunner } from "../exec.ts";

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

describe("command hook timer lifecycle", () => {
  it("clears the execution timeout when the process finishes first", async () => {
    const timeoutHandle = {} as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      (() => timeoutHandle) as unknown as typeof setTimeout,
    );
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
      stdout: emptyStream(),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
      kill: () => {},
    } as never);

    try {
      const outcome = await fireEntry(
        { matcher: "", command: "true" },
        { kind: "stop", ctx: { sessionId: "test" } },
        60_000,
      );
      expect(outcome.kind).toBe("ok");
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle);
    } finally {
      spawnSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });
});

describe("non-command hook handlers", () => {
  it("normalizes agent and HTTP entry schemas under reference event keys", () => {
    const hooks = normalizeHooksConfig({
      Stop: [{ type: "agent", matcher: "*", prompt: "Verify", model: "test-model" }],
      PostToolBatch: [
        {
          type: "http",
          matcher: "*",
          url: "https://hooks.example.test/check",
          headers: { Authorization: "Bearer $HOOK_TOKEN" },
          allowedEnvVars: ["HOOK_TOKEN"],
        },
      ],
    });

    expect(hooks?.stop?.[0]).toMatchObject({
      type: "agent",
      prompt: "Verify",
      model: "test-model",
    });
    expect(hooks?.postToolBatch?.[0]).toMatchObject({
      type: "http",
      url: "https://hooks.example.test/check",
      allowedEnvVars: ["HOOK_TOKEN"],
    });
  });

  it("posts the event payload and interpolates only allowed header variables", async () => {
    let request:
      | { body: unknown; authorization: string | null; redacted: string | null }
      | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(input) {
        request = {
          body: await input.json(),
          authorization: input.headers.get("authorization"),
          redacted: input.headers.get("x-redacted"),
        };
        return Response.json({ systemMessage: "checked" });
      },
    });
    const previous = process.env.TEST_HOOK_TOKEN;
    process.env.TEST_HOOK_TOKEN = "test-token";
    try {
      const outcome = await fireEntry(
        {
          type: "http",
          matcher: "*",
          url: `http://127.0.0.1:${server.port}/hook`,
          command: `http://127.0.0.1:${server.port}/hook`,
          headers: {
            Authorization: "Bearer $TEST_HOOK_TOKEN",
            "X-Redacted": "$UNLISTED_HOOK_TOKEN",
          },
          allowedEnvVars: ["TEST_HOOK_TOKEN"],
        },
        {
          kind: "cwdChanged",
          ctx: {
            oldCwd: "/workspace/old",
            newCwd: "/workspace/new",
            sessionId: "session-1",
            cwd: "/workspace/new",
          },
        },
      );

      expect(outcome.kind).toBe("ok");
      expect(request).toEqual({
        body: {
          hook_event_name: "CwdChanged",
          old_cwd: "/workspace/old",
          new_cwd: "/workspace/new",
          session_id: "session-1",
          cwd: "/workspace/new",
        },
        authorization: "Bearer test-token",
        redacted: "",
      });
    } finally {
      server.stop(true);
      if (previous === undefined) delete process.env.TEST_HOOK_TOKEN;
      else process.env.TEST_HOOK_TOKEN = previous;
    }
  });

  it("runs an agent check with substituted JSON and returns its blocking reason", async () => {
    let request: Parameters<Parameters<typeof registerAgentHookRunner>[1]>[0] | undefined;
    registerAgentHookRunner("session-2", async (input) => {
      request = input;
      return { ok: false, reason: "tests did not pass" };
    });
    try {
      const outcome = await fireEntry(
        {
          type: "agent",
          matcher: "*",
          prompt: "Verify $ARGUMENTS",
          command: "Verify $ARGUMENTS",
          model: "test-model",
          timeout: 7,
        },
        { kind: "stop", ctx: { sessionId: "session-2" } },
      );

      expect(outcome).toEqual({ kind: "prompt_blocked", reason: "tests did not pass" });
      expect(request?.entry.model).toBe("test-model");
      expect(request?.timeoutMs).toBe(7_000);
      expect(request?.prompt).toContain('"hook_event_name":"Stop"');
    } finally {
      _resetAgentHookRunnersForTests();
    }
  });
});
