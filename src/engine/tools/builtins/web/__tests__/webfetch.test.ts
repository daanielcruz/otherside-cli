import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import * as oneshotModule from "@/engine/transport/_infra/classify/oneshot.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const originalOneshot: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(oneshotModule)) {
  originalOneshot[key] = (oneshotModule as Record<string | symbol, unknown>)[key];
}

let capturedModel: string | undefined;
mock.module("@/engine/transport/_infra/classify/oneshot.ts", () => ({
  ...originalOneshot,
  queryModel: async (_ctx: unknown, opts: { model?: string }) => {
    capturedModel = opts.model;
    return { text: "PAGE SUMMARY" };
  },
}));

afterAll(() => {
  mock.module("@/engine/transport/_infra/classify/oneshot.ts", () => originalOneshot);
});

import { WebFetch } from "../webfetch.ts";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  capturedModel = undefined;
});

function ctx(over: Partial<RequestContext>): RequestContext {
  return {
    provider: "xai",
    model: "grok-4.5",
    sessionId: "s1",
    cwd: "/tmp",
    effort: null,
    permissionMode: "default",
    ...over,
  } as RequestContext;
}

function call(): ToolCall {
  return {
    id: "c1",
    input: { url: "https://example.com", prompt: "what?" },
  } as unknown as ToolCall;
}

function htmlResponse(): Response {
  return new Response("<html><body><h1>Hi</h1><p>Body text.</p></body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

describe("WebFetch gate model selection", () => {
  it("uses the active provider's scout model for the gate", async () => {
    global.fetch = mock(async () => htmlResponse()) as unknown as typeof fetch;
    const res = await WebFetch.run(call(), ctx({ provider: "xai", model: "grok-4.5" }));
    expect(res.is_error).toBeFalsy();
    expect(capturedModel).toBe("grok-composer-2.5-fast");
  });

  it("falls back to the session model when the provider has no scout/warrior tier", async () => {
    global.fetch = mock(async () => htmlResponse()) as unknown as typeof fetch;
    const res = await WebFetch.run(
      call(),
      ctx({ provider: "openai-custom", model: "custom-model-x" }),
    );
    expect(res.is_error).toBeFalsy();
    expect(capturedModel).toBe("custom-model-x");
  });
});
