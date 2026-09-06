import { describe, expect, it } from "bun:test";
import "@/engine/providers/bootstrap.ts";
import { translateRequestAntigravity } from "@/engine/providers/antigravity/translate.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const IMAGE_DATA = "aW1hZ2U=";

interface WirePart {
  functionResponse?: { id?: string };
  inlineData?: { mimeType: string; data: string };
}

interface WireContent {
  role: string;
  parts: WirePart[];
}

function ctx(): RequestContext {
  return {
    provider: "antigravity",
    model: "gemini-3.6-flash-high",
    effort: null,
    permissionMode: "default",
    sessionId: "tool-result-image-wire-test",
    cwd: "/tmp",
  } as unknown as RequestContext;
}

function requestContents(messages: Message[]): WireContent[] {
  const request = translateRequestAntigravity(ctx(), messages, []) as {
    contents: WireContent[];
  };
  return request.contents;
}

function inlineDataParts(messages: Message[]): Array<{ mimeType: string; data: string }> {
  return requestContents(messages)
    .flatMap((content) => content.parts)
    .flatMap((part) => (part.inlineData ? [part.inlineData] : []));
}

describe("antigravity image wire", () => {
  it("preserves tool-result images as inlineData", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Read",
            input: { file_path: "/tmp/screenshot.png" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: IMAGE_DATA },
              },
            ],
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "describe this" }] },
    ];

    const toolResultContent = requestContents(messages).find((content) =>
      content.parts.some((part) => part.functionResponse?.id === "call_1"),
    );
    expect(toolResultContent?.parts).toContainEqual({
      inlineData: { mimeType: "image/png", data: IMAGE_DATA },
    });
  });

  it("preserves direct user images as inlineData", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: IMAGE_DATA },
          },
        ],
      },
    ];

    expect(inlineDataParts(messages)).toContainEqual({
      mimeType: "image/png",
      data: IMAGE_DATA,
    });
  });
});
