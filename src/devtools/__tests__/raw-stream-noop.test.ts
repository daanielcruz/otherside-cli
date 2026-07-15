import { afterEach, describe, expect, it } from "bun:test";
import { dispatch } from "@/engine/tools/pipeline.ts";
import type { RequestContext, ScopedToolHandler } from "@/kernel/std/types/request.ts";

const saved = process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY_NOOP_TOOLS;

afterEach(() => {
  if (saved === undefined) delete process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY_NOOP_TOOLS;
  else process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY_NOOP_TOOLS = saved;
});

describe("raw stream replay tool suppression", () => {
  it("executes tools normally when the replay gate is absent", async () => {
    delete process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY_NOOP_TOOLS;
    let executions = 0;
    const result = await dispatch(
      { id: "call-live", name: "Fixture", input: {} },
      context(handler(() => executions++)),
      { permission: async () => "allow", hooks: [] },
    );

    expect(executions).toBe(1);
    expect(result.content).toBe("executed");
  });

  it("keeps orchestration tools live during replay", async () => {
    process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY_NOOP_TOOLS = "1";
    let executions = 0;
    const result = await dispatch(
      { id: "call-agent", name: "Agent", input: {} },
      context(
        handler(() => executions++),
        "Agent",
      ),
      { permission: async () => "allow", hooks: [] },
    );

    expect(executions).toBe(1);
    expect(result.content).toBe("executed");
  });

  it("suppresses tools only when replay explicitly enables it", async () => {
    process.env.OTHERSIDE_CODEX_RAW_STREAM_REPLAY_NOOP_TOOLS = "1";
    let executions = 0;
    let permissions = 0;
    const result = await dispatch(
      { id: "call-replay", name: "Fixture", input: { destructive: true } },
      context(handler(() => executions++)),
      {
        permission: async () => {
          permissions += 1;
          return "allow";
        },
        hooks: [],
      },
    );

    expect(executions).toBe(0);
    expect(permissions).toBe(0);
    expect(result).toEqual({
      tool_use_id: "call-replay",
      content: "Raw stream replay suppressed tool execution.",
    });
  });
});

function handler(onRun: () => void): ScopedToolHandler {
  return {
    schema: {
      name: "Fixture",
      description: "Fixture",
      inputSchema: { type: "object" },
    },
    run: async (call) => {
      onRun();
      return { tool_use_id: call.id, content: "executed" };
    },
  };
}

function context(tool: ScopedToolHandler, name = "Fixture"): RequestContext {
  return {
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "medium",
    permissionMode: "yolo",
    sessionId: "raw-stream-replay-test",
    cwd: process.cwd(),
    scopedToolHandlers: new Map([[name, tool]]),
  };
}
