import { afterEach, describe, expect, it } from "bun:test";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { clearReadStateForScope, readScopeKey, readSetContains, readSetInsert } from "../state.ts";

const scope = "read-state-test";

describe("READ_STATE", () => {
  afterEach(() => {
    clearReadStateForScope(scope);
  });

  it("evicts oldest entries when cached content exceeds the byte cap", () => {
    const oneMiB = "x".repeat(1024 * 1024);

    for (let i = 0; i < 26; i += 1) {
      readSetInsert(scope, `missing-${i}.txt`, oneMiB);
    }

    expect(readSetContains(scope, "missing-0.txt")).toBe(false);
    expect(readSetContains(scope, "missing-25.txt")).toBe(true);
  });
});

describe("readScopeKey", () => {
  const baseCtx = {
    provider: "anthropic",
    model: "model",
    sessionId: "session-1",
    cwd: "/tmp",
  } as unknown as RequestContext;

  it("keeps the main scope for the main conversation", () => {
    expect(readScopeKey(baseCtx)).toBe("main");
  });

  it("scopes each agent to its own bucket", () => {
    const forkCtx = {
      ...baseCtx,
      parentThreadId: "session-1",
      agentOwnerId: "agent-a",
    } as RequestContext;
    expect(readScopeKey(forkCtx)).toBe("agent-a");
  });

  it("falls back to the session bucket for a child without an owner id", () => {
    const childCtx = { ...baseCtx, parentThreadId: "session-1" } as RequestContext;
    expect(readScopeKey(childCtx)).toBe("session-1");
  });
});
