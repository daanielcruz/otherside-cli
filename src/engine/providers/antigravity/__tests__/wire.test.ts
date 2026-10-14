import { describe, expect, it } from "bun:test";
import "@/engine/providers/bootstrap.ts";
import { userAgent } from "@/engine/providers/antigravity/fingerprint.ts";
import {
  flattenChoiceCombinators,
  translateRequestAntigravity,
  translateResponseAntigravity,
} from "@/engine/providers/antigravity/translate.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function ctx(model = "claude-sonnet-4-6"): RequestContext {
  return {
    provider: "antigravity",
    model,
    effort: null,
    permissionMode: "default",
    sessionId: "wire-test-session",
    cwd: "/tmp",
  } as unknown as RequestContext;
}

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

const tools = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "write_file",
    description: "Write a file",
    parameters: { type: "object", properties: {} },
  },
];

describe("antigravity wire", () => {
  it("emits the installed client User-Agent format", () => {
    expect(userAgent()).toMatch(
      /^antigravity\/cli\/1\.3\.4 \(aidev_client; os_type=\w+; arch=\w+; cl=998275202; auth_method=consumer\)$/,
    );
  });

  it("labels omit last_execution_id on a single-user-turn request (9 keys)", () => {
    const req = translateRequestAntigravity(ctx(), messages, tools) as Record<string, unknown>;
    expect(req.toolConfig).toBeUndefined();
    const labels = req.labels as Record<string, string>;
    expect(Object.keys(labels)).toEqual([
      "cascade_id",
      "last_step_index",
      "model_enum",
      "request_id",
      "root_cascade_id",
      "trajectory_id",
      "used_claude",
      "used_claude_conservative",
      "used_non_gemini_model",
    ]);
    expect(labels.last_execution_id).toBeUndefined();
    expect(labels.request_id).toBe(`${labels.trajectory_id}-0`);
  });

  it("encodes native PDF tool results as inlineData only for PDF-capable models", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "pdf", name: "Read", input: { file_path: "/tmp/a.pdf" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "pdf",
            content: [
              {
                type: "pdf",
                source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
                filename: "a.pdf",
                pageCount: 1,
                bytes: 3,
              },
            ],
          },
        ],
      },
    ];

    const native = translateRequestAntigravity(ctx("gemini-3.8-flash"), messages, []) as {
      contents: unknown;
    };
    expect(native.contents).toEqual([
      {
        role: "model",
        parts: [
          {
            functionCall: { id: "pdf", name: "Read", args: { file_path: "/tmp/a.pdf" } },
            thoughtSignature: "skip_thought_signature_validator",
          },
        ],
      },
      {
        role: "model",
        parts: [
          {
            functionResponse: {
              id: "pdf",
              name: "Read",
              response: { output: "" },
              parts: [{ inlineData: { mimeType: "application/pdf", data: "cGRm" } }],
            },
          },
        ],
      },
    ]);

    const unsupported = translateRequestAntigravity(ctx(), messages, []) as { contents: unknown };
    expect(unsupported.contents).toEqual([
      {
        role: "model",
        parts: [{ functionCall: { id: "pdf", name: "Read", args: { file_path: "/tmp/a.pdf" } } }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "pdf",
              name: "Read",
              response: {
                output:
                  "[PDF content is unavailable on this provider. Re-read the file to provide page images.]",
              },
            },
          },
        ],
      },
    ]);
  });

  it("labels carry last_execution_id when contents has a prior completed execution (10 keys)", () => {
    const continuedMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ];
    const req = translateRequestAntigravity(ctx(), continuedMessages, tools) as Record<
      string,
      unknown
    >;
    const labels = req.labels as Record<string, string>;
    expect(Object.keys(labels)).toEqual([
      "cascade_id",
      "last_execution_id",
      "last_step_index",
      "model_enum",
      "request_id",
      "root_cascade_id",
      "trajectory_id",
      "used_claude",
      "used_claude_conservative",
      "used_non_gemini_model",
    ]);
    expect(labels.last_execution_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(labels.request_id).toBe(`${labels.trajectory_id}-1`);
  });

  it("emits one functionDeclarations entry per tool, keyed name->description->parameters", () => {
    const req = translateRequestAntigravity(ctx(), messages, tools) as Record<string, unknown>;
    const entries = req.tools as Array<Record<string, unknown>>;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBe(2);
    for (const entry of entries) {
      const fds = entry.functionDeclarations as Array<Record<string, unknown>>;
      expect(fds.length).toBe(1);
      expect(Object.keys(fds[0]!)).toEqual(["name", "description", "parameters"]);
    }
    const names = entries.map(
      (e) => (e.functionDeclarations as Array<Record<string, unknown>>)[0]!.name,
    );
    expect(names).toEqual(["read_file", "write_file"]);
  });

  describe("flattenChoiceCombinators", () => {
    it("TaskUpdate-shaped status anyOf -> {type: 'string'}", () => {
      const input = {
        anyOf: [
          { type: "string", enum: ["pending", "in_progress", "completed"] },
          { type: "string" },
        ],
      };
      const output = flattenChoiceCombinators(input);
      expect(output).toEqual({ type: "string" });
    });

    it("two enum branches -> merged enum union", () => {
      const input = {
        anyOf: [
          { type: "string", enum: ["pending", "in_progress"] },
          { type: "string", enum: ["completed"] },
        ],
      };
      const output = flattenChoiceCombinators(input);
      expect(output).toEqual({
        type: "string",
        enum: ["pending", "in_progress", "completed"],
      });
    });

    it("mixed types -> combinator dropped", () => {
      const input = {
        description: "some status",
        anyOf: [{ type: "string", enum: ["pending"] }, { type: "number" }],
      };
      const output = flattenChoiceCombinators(input);
      expect(output).toEqual({
        description: "some status",
      });
    });

    it("recursion into nested properties and items", () => {
      const input = {
        type: "object",
        properties: {
          status: {
            anyOf: [
              { type: "string", enum: ["pending"] },
              { type: "string", enum: ["completed"] },
            ],
          },
        },
        items: {
          anyOf: [
            { type: "string", enum: ["a"] },
            { type: "string", enum: ["b"] },
          ],
        },
      };
      const output = flattenChoiceCombinators(input);
      expect(output).toEqual({
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "completed"],
          },
        },
        items: {
          type: "string",
          enum: ["a", "b"],
        },
      });
    });
  });

  it("gemini (non-claude) spec -> schema untouched (anyOf preserved)", () => {
    const geminiCtx = {
      provider: "antigravity",
      model: "gemini-3.8-flash",
      effort: null,
      permissionMode: "default",
      sessionId: "wire-test-session",
      cwd: "/tmp",
    } as unknown as RequestContext;

    const testTools = [
      {
        name: "test_tool",
        description: "Test tool description",
        parameters: {
          type: "object",
          properties: {
            status: {
              anyOf: [{ type: "string", enum: ["pending", "completed"] }, { type: "string" }],
            },
          },
        },
      },
    ];

    const req = translateRequestAntigravity(geminiCtx, messages, testTools) as Record<
      string,
      unknown
    >;
    const tools = req.tools as Record<string, unknown>[] | undefined;
    const decls = tools?.[0]?.functionDeclarations as Record<string, unknown>[] | undefined;
    const params = decls?.[0]?.parameters as Record<string, unknown> | undefined;
    const properties = params?.properties as Record<string, unknown> | undefined;
    const status = properties?.status as Record<string, unknown> | undefined;
    expect(status?.anyOf).toBeDefined();
    expect(status?.type).toBeUndefined();
  });

  it("claude spec -> schema flattened (anyOf transformed)", () => {
    const claudeCtx = {
      provider: "antigravity",
      model: "claude-sonnet-4-6",
      effort: null,
      permissionMode: "default",
      sessionId: "wire-test-session",
      cwd: "/tmp",
    } as unknown as RequestContext;

    const testTools = [
      {
        name: "test_tool",
        description: "Test tool description",
        parameters: {
          type: "object",
          properties: {
            status: {
              anyOf: [{ type: "string", enum: ["pending", "completed"] }, { type: "string" }],
            },
          },
        },
      },
    ];

    const req = translateRequestAntigravity(claudeCtx, messages, testTools) as Record<
      string,
      unknown
    >;
    const tools = req.tools as Record<string, unknown>[] | undefined;
    const decls = tools?.[0]?.functionDeclarations as Record<string, unknown>[] | undefined;
    const params = decls?.[0]?.parameters as Record<string, unknown> | undefined;
    const properties = params?.properties as Record<string, unknown> | undefined;
    const status = properties?.status as Record<string, unknown> | undefined;
    expect(status?.anyOf).toBeUndefined();
    expect(status?.type).toBe("string");
  });

  it("emits a single consolidated usage event when cachedContentTokenCount arrives only on the final SSE frame", async () => {
    const frames = [
      `data: ${JSON.stringify({
        response: {
          candidates: [
            { content: { role: "model", parts: [{ text: "thinking", thought: true }] } },
          ],
          usageMetadata: {
            promptTokenCount: 30_518,
            totalTokenCount: 30_649,
            thoughtsTokenCount: 131,
          },
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "answer", thoughtSignature: "sig_final" }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 30_786,
            candidatesTokenCount: 138,
            totalTokenCount: 31_357,
            cachedContentTokenCount: 28_018,
            thoughtsTokenCount: 433,
          },
        },
      })}\n\n`,
    ];
    async function* sse(): AsyncIterable<Uint8Array> {
      for (const frame of frames) yield Buffer.from(frame, "utf8");
    }
    const events: ProviderEvent[] = [];
    for await (const ev of translateResponseAntigravity(sse())) events.push(ev);
    const usages = events.filter((ev) => ev.kind === "usage");
    expect(usages).toEqual([
      {
        kind: "usage",
        inputTokens: 2_768,
        outputTokens: 138,
        thoughtTokens: 433,
        cacheReadInputTokens: 28_018,
      },
    ]);
  });

  it("raises a bare mid-stream error frame instead of ending the turn as a success", async () => {
    const frames = [
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "Partial" }] } }] } })}\n\n`,
      `${JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exhausted", details: [{ reason: "QUOTA_EXHAUSTED" }] } })}\n\n`,
    ];
    async function* sse(): AsyncIterable<Uint8Array> {
      for (const frame of frames) yield Buffer.from(frame, "utf8");
    }
    const events: ProviderEvent[] = [];
    let thrown: unknown;
    try {
      for await (const ev of translateResponseAntigravity(sse())) events.push(ev);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ provider: "antigravity", status: 429 });
    expect(events.some((ev) => ev.kind === "message_stop")).toBe(false);
  });

  it("preserves valid contents across in-session transitions (gemini-4-argon -> gemini-3.8-flash -> non-antigravity -> claude-sonnet-4-6 -> gemini-4-argon)", () => {
    const priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = "/nonexistent-wire-test-config-dir";
    try {
      const multiTurn: Message[] = [
        { role: "user", content: [{ type: "text", text: "step 1" }] },
        {
          role: "assistant",
          producedBy: "antigravity",
          producedModel: "gemini-4-argon",
          content: [
            {
              type: "thinking",
              text: "argon thought",
              signature: "sig_argon_1",
              producedBy: "antigravity",
              producedModel: "gemini-4-argon",
            },
            { type: "tool_use", id: "call_argon", name: "read_file", input: { path: "a.ts" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_argon", content: "file a" }],
        },
        {
          role: "assistant",
          producedBy: "antigravity",
          producedModel: "gemini-4-argon",
          content: [
            {
              type: "thinking",
              text: "argon reply thought",
              signature: "sig_argon_2",
              producedBy: "antigravity",
              producedModel: "gemini-4-argon",
            },
            { type: "text", text: "argon done" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "step 2 on flash" }] },
        {
          role: "assistant",
          producedBy: "antigravity",
          producedModel: "gemini-3.8-flash",
          content: [
            {
              type: "thinking",
              text: "flash thought",
              signature: "sig_flash_1",
              producedBy: "antigravity",
              producedModel: "gemini-3.8-flash",
            },
            { type: "text", text: "flash done" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "step 3 on deepseek" }] },
        {
          role: "assistant",
          producedBy: "deepseek",
          producedModel: "deepseek-v4-pro",
          content: [
            {
              type: "thinking",
              text: "ds thought",
              producedBy: "deepseek",
              producedModel: "deepseek-v4-pro",
            },
            { type: "tool_use", id: "call_ds", name: "read_file", input: { path: "b.ts" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_ds", content: "file b" }],
        },
        {
          role: "assistant",
          producedBy: "deepseek",
          producedModel: "deepseek-v4-pro",
          content: [{ type: "text", text: "deepseek done" }],
        },
        { role: "user", content: [{ type: "text", text: "step 4 back to argon" }] },
      ];

      // 1. Request targeting gemini-3.8-flash replaces argon signatures with placeholder on tool call and omits foreign text signature
      const flashReq = translateRequestAntigravity(ctx("gemini-3.8-flash"), multiTurn, tools) as {
        contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      };
      expect(flashReq.contents[1]?.parts[0]?.thoughtSignature).toBe(
        "skip_thought_signature_validator",
      );
      expect(flashReq.contents[2]?.role).toBe("model");
      expect(flashReq.contents[3]?.parts[0]?.thoughtSignature).toBeUndefined();
      expect(flashReq.contents[5]?.parts[0]?.thoughtSignature).toBe("sig_flash_1");

      // 2. Request targeting claude-sonnet-4-6 on Antigravity sends tool results as user and omits synthetic Gemini thoughtSignature
      const claudeReq = translateRequestAntigravity(ctx("claude-sonnet-4-6"), multiTurn, tools) as {
        contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      };
      expect(claudeReq.contents[2]?.role).toBe("user");
      expect(claudeReq.contents[1]?.parts[0]?.thoughtSignature).toBeUndefined();

      // 3. Request returning to gemini-4-argon restores argon's own signatures and signs foreign tool calls with placeholder
      const argonReq = translateRequestAntigravity(ctx("gemini-4-argon"), multiTurn, tools) as {
        contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
        generationConfig: { thinkingConfig: Record<string, unknown> };
      };
      expect(argonReq.generationConfig.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingLevel: "MEDIUM",
      });
      expect(argonReq.contents[1]?.parts[0]?.thoughtSignature).toBe("sig_argon_1");
      expect(argonReq.contents[2]?.role).toBe("model");
      expect(argonReq.contents[3]?.parts[0]?.thoughtSignature).toBe("sig_argon_2");
      expect(argonReq.contents[5]?.parts[0]?.thoughtSignature).toBeUndefined();
      expect(argonReq.contents[7]?.parts[0]?.thoughtSignature).toBe(
        "skip_thought_signature_validator",
      );
      expect(argonReq.contents[8]?.role).toBe("model");
    } finally {
      if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
      else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
    }
  });
});
