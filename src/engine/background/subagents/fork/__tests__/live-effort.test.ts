import { describe, expect, it } from "bun:test";
import {
  withEffortOverride,
  withLiveBrokerEffort,
} from "@/engine/background/subagents/dispatcher.ts";
import { defaultEffortForModel } from "@/engine/model/catalog.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import type { BrokerHandle, RequestContext } from "@/kernel/std/types/request.ts";

registerAllProviders();

function brokerWithEffort(effort: string | null): BrokerHandle {
  return { read: () => ({ effort }) } as unknown as BrokerHandle;
}

function ctxWith(overrides: Partial<RequestContext>): RequestContext {
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
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

describe("withEffortOverride", () => {
  it("runs the agent at the effort the caller named", () => {
    expect(withEffortOverride(ctxWith({ effort: "high" }), "low").effort).toBe("low");
  });

  it("keeps the routed effort when the caller named none", () => {
    const ctx = ctxWith({ effort: "high" });
    expect(withEffortOverride(ctx, undefined)).toBe(ctx);
  });

  it("settles a level the routed model lacks to that model's default", () => {
    const grok = ctxWith({ provider: "xai", model: "grok-4.7", effort: "high" });
    expect(withEffortOverride(grok, "max").effort).toBe(
      defaultEffortForModel({ provider: "xai", model: "grok-4.7" }),
    );
    expect(withEffortOverride(grok, "xhigh").effort).toBe("xhigh");
  });

  it("leaves an effort-less model without one", () => {
    const composer = ctxWith({ provider: "xai", model: "grok-composer-2.5-fast", effort: null });
    expect(withEffortOverride(composer, "high").effort).toBeNull();
  });
});
