import { describe, expect, it } from "bun:test";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { createConcurrencyGate, workflowConcurrencyLimit } from "../concurrency.ts";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("workflowConcurrencyLimit", () => {
  it("honors a configured fixed limit above the cpu default", () => {
    // antigravity has a fixed override; anthropic has none — it now uses the
    // machine-scaled default like any other uncapped provider.
    expect(workflowConcurrencyLimit("antigravity")).toBe(8);
  });

  it("resolves a plan-tiered provider by its plan", () => {
    expect(workflowConcurrencyLimit("glm", "lite")).toBe(1);
    expect(workflowConcurrencyLimit("glm", "max")).toBe(7);
    expect(workflowConcurrencyLimit("minimax", "plus")).toBe(4);
  });

  it("falls back to a positive machine-scaled default for uncapped providers", () => {
    expect(workflowConcurrencyLimit("codex")).toBeGreaterThanOrEqual(2);
    expect(workflowConcurrencyLimit()).toBeGreaterThanOrEqual(2);
  });

  it("scales the machine-default (anthropic included) as min(16, max(2, cpuCount - 2))", () => {
    // anthropic has no fixed override, so it takes the injected cpu count
    // through the same uncapped-default formula as any other provider.
    expect(workflowConcurrencyLimit("anthropic", null, 4)).toBe(2);
    expect(workflowConcurrencyLimit("anthropic", null, 8)).toBe(6);
    expect(workflowConcurrencyLimit("anthropic", null, 32)).toBe(16);
  });

  it("clamps the machine-scaled default to a floor of 2 on low-core machines", () => {
    expect(workflowConcurrencyLimit(undefined, undefined, 1)).toBe(2);
    expect(workflowConcurrencyLimit(undefined, undefined, 2)).toBe(2);
    expect(workflowConcurrencyLimit(undefined, undefined, 3)).toBe(2);
  });

  it("clamps the machine-scaled default to a ceiling of 16 on high-core machines", () => {
    expect(workflowConcurrencyLimit(undefined, undefined, 64)).toBe(16);
  });

  it("a fixed provider override ignores the injected cpu count", () => {
    expect(workflowConcurrencyLimit("antigravity", null, 4)).toBe(8);
  });
});

describe("createConcurrencyGate — per-provider isolation", () => {
  it("caps each provider by its own limit, independently", async () => {
    const gate = createConcurrencyGate({
      limitFor: async (p) => (p === "glm" ? 1 : 3),
    });

    // Fill glm to its limit of 1.
    await gate.acquire("glm");
    // A second glm acquire must block (limit 1).
    let secondGlmGranted = false;
    const secondGlm = gate.acquire("glm").then(() => {
      secondGlmGranted = true;
    });
    await flush();
    expect(secondGlmGranted).toBe(false);

    // A different provider is unaffected by glm being full — runs at its own limit.
    await gate.acquire("codex");
    await gate.acquire("codex");
    await gate.acquire("codex");
    let fourthCodexGranted = false;
    const fourthCodex = gate.acquire("codex").then(() => {
      fourthCodexGranted = true;
    });
    await flush();
    expect(fourthCodexGranted).toBe(false); // codex full at 3

    // Releasing glm frees the queued glm waiter, not codex.
    gate.release("glm");
    await secondGlm;
    expect(secondGlmGranted).toBe(true);
    expect(fourthCodexGranted).toBe(false);

    // Releasing one codex frees the queued codex waiter.
    gate.release("codex");
    await fourthCodex;
    expect(fourthCodexGranted).toBe(true);
  });

  it("has no joint ceiling — providers run concurrently up to the sum of limits", async () => {
    const gate = createConcurrencyGate({ limitFor: async () => 2 });
    const providers: ProviderId[] = ["anthropic", "antigravity", "codex"];
    // 2 slots each × 3 providers = 6 concurrent, no global cap gets in the way.
    await Promise.all(providers.flatMap((p) => [gate.acquire(p), gate.acquire(p)]));
    // A 3rd acquire on any one provider blocks (that provider is at its own limit)...
    let extraGranted = false;
    gate.acquire("anthropic").then(() => {
      extraGranted = true;
    });
    await flush();
    expect(extraGranted).toBe(false);
  });

  it("shares one pool for concurrent first-acquires of a new provider (no create race)", async () => {
    let limitCalls = 0;
    const gate = createConcurrencyGate({
      limitFor: async (_p) => {
        limitCalls += 1;
        await flush();
        return 1;
      },
    });
    // Two simultaneous first-acquires of the same provider.
    const a = gate.acquire("kimi");
    const b = gate.acquire("kimi").then(() => "b-granted");
    await a;
    await flush();
    // limitFor ran exactly once → one shared pool, so b must be blocked at limit 1.
    expect(limitCalls).toBe(1);
    const raced = await Promise.race([b, flush().then(() => "b-blocked")]);
    expect(raced).toBe("b-blocked");
  });
});
