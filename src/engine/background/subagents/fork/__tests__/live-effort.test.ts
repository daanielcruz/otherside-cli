import { describe, expect, it } from "bun:test";
import { withLiveBrokerEffort } from "@/engine/background/subagents/dispatcher.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import type { BrokerHandle, RequestContext } from "@/kernel/std/types/request.ts";

registerAllProviders();

function brokerWithEffort(effort: string | null): BrokerHandle {
  return { read: () => ({ effort }) } as unknown as BrokerHandle;
}

function ctxWith(overrides: Partial<RequestContext>): RequestContext {
  return {
    provider: "anthropic",
    model: "claude-opus-4-8",
    effort: "medium",
    permissionMode: "default",
    sessionId: "t",
    cwd: "/tmp",
    ...overrides,
  } as RequestContext;
}

describe("withLiveBrokerEffort", () => {
  it("refreshes a stale ctx effort from the live broker", () => {
    const ctx = ctxWith({ effort: "medium", broker: brokerWithEffort("high") });
    expect(withLiveBrokerEffort(ctx).effort).toBe("high");
  });

  it("returns the same ctx when there is no broker", () => {
    const ctx = ctxWith({ effort: "medium" });
    expect(withLiveBrokerEffort(ctx)).toBe(ctx);
  });

  it("is a no-op when the live effort already matches", () => {
    const ctx = ctxWith({ effort: "high", broker: brokerWithEffort("high") });
    expect(withLiveBrokerEffort(ctx)).toBe(ctx);
  });

  it("clamps a live effort the model does not support to the model default", () => {
    const ctx = ctxWith({ effort: "medium", broker: brokerWithEffort("bogus") });
    expect(withLiveBrokerEffort(ctx).effort).not.toBe("bogus");
  });
});
