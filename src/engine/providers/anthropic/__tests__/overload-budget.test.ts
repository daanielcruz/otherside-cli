import { describe, expect, it } from "bun:test";
import { ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import { config } from "@/engine/providers/anthropic/config.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function ctx(): RequestContext {
  return {
    provider: "anthropic",
    model: "claude-fable-5",
    effort: "high",
    permissionMode: "default",
    sessionId: "anthropic-overload-budget",
    cwd: "/tmp",
  } as RequestContext;
}

function overloadedError() {
  return new ProviderHttpError({
    provider: "anthropic",
    status: 529,
    body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  });
}

describe("anthropic 529 overload budget", () => {
  it("retries overload until attempt 3, then fails terminal", () => {
    const first = config.recoverableError?.(overloadedError(), ctx(), 1);
    expect(first?.kind).toBe("retry");

    const second = config.recoverableError?.(overloadedError(), ctx(), 2);
    expect(second?.kind).toBe("retry");

    const third = config.recoverableError?.(overloadedError(), ctx(), 3);
    expect(third).toMatchObject({
      kind: "fail",
      status: 529,
    });
    expect(third && "userMessage" in third ? third.userMessage : "").toMatch(/overloaded/i);
  });
});
