import { describe, expect, it } from "bun:test";
import { release as osRelease } from "node:os";
import { NON_VISION_IMAGE_PLACEHOLDER } from "@/engine/model/facts/capabilities.ts";
import { buildGlmWebSearchBody } from "@/engine/tools/glm.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { MODELS } from "../config.ts";
import {
  API_MESSAGES_URL,
  authHeader,
  fingerprint,
  ZCODE_BETA_WEB_SEARCH,
} from "../fingerprint.ts";
import { translateRequestGlm } from "../translate.ts";

const ctx: RequestContext = {
  provider: "glm",
  model: "glm-5.2",
  effort: "high",
  permissionMode: "default",
  sessionId: "sess-glm-wire",
  cwd: "/tmp/glm-wire",
  agentic: true,
};

function redactVolatile(headers: Record<string, string>): Record<string, string> {
  const out = { ...headers };
  for (const key of ["x-query-id", "x-request-id", "x-zcode-trace-id"]) out[key] = `<${key}>`;
  return out;
}

describe("glm ZCode wire bodies", () => {
  it("uses the API-key Anthropic Messages endpoint", () => {
    expect(API_MESSAGES_URL).toBe("https://api.z.ai/api/anthropic/v1/messages");
  });

  it("builds ZCode auth and request headers", () => {
    const fp = fingerprint(ctx);
    expect(
      redactVolatile({ "user-agent": fp.userAgent, ...fp.extraHeaders, ...authHeader("jwt") }),
    ).toEqual({
      "user-agent": "ZCode/3.2.5 ai-sdk/provider-utils/4.0.27 runtime/node.js/24",
      "anthropic-beta": "mid-conversation-system-2026-04-07",
      "anthropic-version": "2023-06-01",
      "http-referer": "https://zcode.z.ai",
      "x-os-category":
        process.platform === "darwin"
          ? "macos"
          : process.platform === "win32"
            ? "windows"
            : process.platform,
      "x-os-version": osRelease(),
      "x-platform": `${process.platform}-${process.arch}`,
      "x-request-id": "<x-request-id>",
      "x-session-id": "sess-glm-wire",
      "x-title": "Z Code@electron",
      "x-zcode-agent": "glm",
      "x-zcode-app-version": "3.2.5",
      "x-zcode-trace-id": "<x-zcode-trace-id>",
      Connection: "close",
      "x-query-id": "<x-query-id>",
      authorization: "Bearer jwt",
      "x-api-key": "jwt",
    });

    const webFp = fingerprint(ctx, ZCODE_BETA_WEB_SEARCH);
    expect(webFp.extraHeaders["anthropic-beta"]).toBe("code-execution-web-tools-2026-02-09");
    expect(webFp.extraHeaders["x-query-id"]).toBeUndefined();
  });

  it("keeps x-query-id stable across subrequests within one turn, fresh on a new turn", () => {
    const turnA1 = fingerprint({ ...ctx, turnId: "turn-a" });
    const turnA2 = fingerprint({ ...ctx, turnId: "turn-a" });
    const turnB1 = fingerprint({ ...ctx, turnId: "turn-b" });

    expect(turnA2.extraHeaders["x-query-id"]).toBe(turnA1.extraHeaders["x-query-id"]);
    expect(turnB1.extraHeaders["x-query-id"]).not.toBe(turnA1.extraHeaders["x-query-id"]);
  });

  it("passes cache_control through verbatim — placement is composeGlmMessages' job, not translate's", () => {
    const messages: Message[] = [
      {
        role: "system",
        content: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
      },
    ];

    expect(translateRequestGlm(ctx, messages, [])).toMatchObject({
      system: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
        },
      ],
    });
  });

  it("replays PDF tool results as an unavailable-content placeholder", () => {
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
    const body = translateRequestGlm(ctx, messages, []) as { messages: unknown };

    expect(body.messages).toEqual([
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
                type: "text",
                text: "[PDF content is unavailable on this provider. Re-read the file to provide page images.]",
              },
            ],
          },
        ],
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("cGRm");
  });

  it("exposes the ZCode GLM model roster", () => {
    expect(MODELS.map((model) => model.id)).toEqual(["glm-5.2", "glm-5-turbo"]);
    expect(Object.fromEntries(MODELS.map((model) => [model.id, model.contextWindow]))).toEqual({
      "glm-5.2": 1_000_000,
      "glm-5-turbo": 200_000,
    });
    expect(Object.fromEntries(MODELS.map((model) => [model.id, model.defaultEffort]))).toEqual({
      "glm-5.2": "max",
      "glm-5-turbo": null,
    });
    expect(Object.fromEntries(MODELS.map((model) => [model.id, model.efforts]))).toEqual({
      "glm-5.2": ["high", "max"],
      "glm-5-turbo": [],
    });
  });

  it("keeps image blocks on GLM-5.2 so Z.AI can run its server-side image tool", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } },
        ],
      },
    ];

    expect(translateRequestGlm(ctx, messages, [])).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } },
          ],
        },
      ],
    });
  });

  it("strips image blocks on GLM-5-Turbo", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } },
        ],
      },
    ];

    const body = translateRequestGlm({ ...ctx, model: "glm-5-turbo" }, messages, []);

    expect(body).toMatchObject({
      model: "GLM-5-Turbo",
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "text", text: NON_VISION_IMAGE_PLACEHOLDER },
          ],
        },
      ],
    });
    expect(body).not.toHaveProperty("output_config");
  });

  it("builds the same-endpoint web_search_20260209 request body", () => {
    expect(buildGlmWebSearchBody("claude mythos")).toEqual({
      model: "GLM-5.2",
      max_tokens: 4096,
      system: [
        {
          type: "text",
          text: "You are an assistant for performing a web search tool use.",
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Perform a web search for the query: claude mythos",
            },
          ],
        },
      ],
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
      tool_choice: { type: "auto" },
      stream: true,
    });
  });
});
