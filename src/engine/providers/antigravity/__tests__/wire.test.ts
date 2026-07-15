import { describe, expect, it } from "bun:test";
import { userAgent } from "@/engine/providers/antigravity/fingerprint.ts";
import {
  flattenChoiceCombinators,
  translateRequestAntigravity,
} from "@/engine/providers/antigravity/translate.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function ctx(): RequestContext {
  return {
    provider: "antigravity",
    model: "claude-sonnet-4-6",
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

describe("antigravity wire (agy 1.1.0)", () => {
  it("emits the 1.1.0 User-Agent format", () => {
    expect(userAgent()).toMatch(
      /^antigravity\/cli\/1\.1\.0 \(aidev_client; os_type=\w+; arch=\w+; auth_method=consumer\)$/,
    );
  });

  it("labels omit last_execution_id on a single-user-turn request (6 keys)", () => {
    const req = translateRequestAntigravity(ctx(), messages, tools) as Record<string, unknown>;
    const labels = req.labels as Record<string, string>;
    expect(Object.keys(labels)).toEqual([
      "last_step_index",
      "model_enum",
      "trajectory_id",
      "used_claude",
      "used_claude_conservative",
      "used_non_gemini_model",
    ]);
    expect(labels.last_execution_id).toBeUndefined();
  });

  it("labels carry last_execution_id first when contents has a prior role:model turn (7 keys)", () => {
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
      "last_execution_id",
      "last_step_index",
      "model_enum",
      "trajectory_id",
      "used_claude",
      "used_claude_conservative",
      "used_non_gemini_model",
    ]);
    expect(labels.last_execution_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
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
      model: "gemini-3-flash",
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
});
