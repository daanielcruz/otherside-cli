import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  clearUsageLimits,
  getCurrentLimits,
  hasObservedUsageLimits,
} from "@/engine/session/usage/limits.ts";
import { ingestAnthropicHeaders } from "../rate-limits.ts";

beforeEach(() => {
  clearUsageLimits();
});

afterEach(() => {
  clearUsageLimits();
});

describe("ingestAnthropicHeaders", () => {
  it("ignores responses without Anthropic rate-limit headers", () => {
    ingestAnthropicHeaders(new Headers({ "content-type": "application/json" }));

    expect(hasObservedUsageLimits()).toBe(false);
  });

  it("does not replace a prior limit snapshot with an empty response", () => {
    ingestAnthropicHeaders(
      new Headers({
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": "123",
      }),
    );
    expect(hasObservedUsageLimits()).toBe(true);
    expect(getCurrentLimits().status).toBe("rejected");

    ingestAnthropicHeaders(new Headers({ "content-type": "application/json" }));

    expect(hasObservedUsageLimits()).toBe(true);
    expect(getCurrentLimits().status).toBe("rejected");
  });
});
