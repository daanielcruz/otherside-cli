import { beforeAll, describe, expect, it } from "bun:test";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { deriveChipUsage } from "@/engine/session/usage/chip-derive.ts";
import type { TokenTotals } from "@/engine/session/usage/provider.ts";
import type { ContextUsageSnapshot } from "@/engine/session/usage/snapshot.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { computeAutoCompactRemainingPct } from "@/ui/app/status-text.ts";
import { buildStatuslineInput, renderNativeStatusline } from "@/ui/chrome/status/line-input.ts";

// Both status-line surfaces must share one context counter: the
// "available/used" pair and the "% until auto-compact" / "N tokens" pair are
// rendered side by side from the same provider usage snapshot, so a divergence
// between them is a contract violation. Regression source: a live session on
// codex gpt-5.6-terra (window 372_000, compact threshold 334_800) showed
// "45K available · 88% used" next to "0% until auto-compact · 459351 tokens".

const MODEL = "gpt-5.6-terra";
const PROVIDER = "codex" as const;

const zeroTotals: TokenTotals = {
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

function derive(args: {
  lastContext: ContextUsageSnapshot;
  messages?: readonly Message[];
  queuedText?: string;
}) {
  return deriveChipUsage({
    mainLastContext: args.lastContext,
    mainTokenTotals: zeroTotals,
    provider: PROVIDER,
    model: MODEL,
    contextWarningSuppressed: false,
    fallbackContextTokens: 0,
    queuedText: args.queuedText ?? "",
    ...(args.messages ? { messages: args.messages } : {}),
    autoCompactRemainingPct: (used) => computeAutoCompactRemainingPct(used, MODEL, PROVIDER),
  });
}

function statuslineUsedSegments(
  chip: ReturnType<typeof derive>,
  lastContext: Parameters<typeof derive>[0]["lastContext"],
) {
  const input = buildStatuslineInput({
    state: { provider: PROVIDER, model: MODEL } as BrokerState,
    sessionId: "s",
    version: "0",
    cwd: "/",
    inputTokens: chip.fallbackInputTokens,
    outputTokens: chip.mainOutputTokens,
    cacheCreationInputTokens: lastContext.cacheCreationInputTokens,
    cacheReadInputTokens: lastContext.cacheReadInputTokens,
    ...(lastContext.contextTokens !== undefined ? { contextTokens: chip.activeContextTotal } : {}),
  });
  return { text: renderNativeStatusline(input), input };
}

describe("chip usage stays consistent with the available/used status surface", () => {
  beforeAll(() => registerAllProviders());

  it("uses 50k active context for the UI while preserving 200k billed tokens", () => {
    const lastContext = {
      inputTokens: 150_000,
      outputTokens: 10_000,
      cacheCreationInputTokens: 15_000,
      cacheReadInputTokens: 25_000,
      contextTokens: 50_000,
    };
    const chip = derive({ lastContext });
    expect(chip.activeContextTotal).toBe(50_000);
    expect(chip.autoCompactWarningPct).toBeUndefined();
    expect(chip.contextBanner).toBeNull();
    const { text, input } = statuslineUsedSegments(chip, lastContext);
    expect(text).toContain("322K available");
    expect(input.context_window.used_percentage).toBe(13);
    expect(input.context_window.remaining_percentage).toBe(87);
    expect(input.context_window.total_input_tokens + input.context_window.total_output_tokens).toBe(
      200_000,
    );
  });

  it("adds only messages after the snapshot and pending queued text", () => {
    const lastContext = {
      inputTokens: 190_000,
      outputTokens: 10_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextTokens: 50_000,
    };
    const chip = derive({
      lastContext,
      queuedText: "x".repeat(40),
      messages: [
        { role: "assistant", content: [{ type: "text", text: "old output" }], usage: lastContext },
        { role: "user", content: [{ type: "text", text: "x".repeat(80) }] },
      ],
    });
    expect(chip.activeContextTotal).toBe(50_030);
    const live = derive({
      lastContext: { ...lastContext, contextTokens: 45_000 },
      messages: [
        { role: "assistant", content: [], usage: lastContext },
        { role: "user", content: [{ type: "text", text: "already consumed by live inference" }] },
      ],
    });
    expect(live.activeContextTotal).toBe(45_000);
  });

  it("estimates unknown context from messages and harness instead of old snapshots or billing", () => {
    const lastContext = {
      inputTokens: 190_000,
      outputTokens: 10_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextTokens: null,
    };
    const chip = derive({
      lastContext,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(40_000) }],
          usage: { ...lastContext, contextTokens: 50_000 },
        },
        { role: "user", content: [{ type: "text", text: "x".repeat(80) }] },
      ],
    });
    expect(chip.activeContextTotal).toBe(26_020);
    expect(chip.autoCompactWarningPct).toBeUndefined();
    const { text, input } = statuslineUsedSegments(chip, lastContext);
    expect(text).toContain("345K available");
    expect(input.context_window.used_percentage).toBe(7);
    expect(lastContext.inputTokens + lastContext.outputTokens).toBe(200_000);
  });

  it("keeps a zero snapshot authoritative on both status surfaces", () => {
    const lastContext = {
      inputTokens: 190_000,
      outputTokens: 10_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextTokens: 0,
    };
    const chip = derive({ lastContext });
    expect(chip.activeContextTotal).toBe(0);
    const { text, input } = statuslineUsedSegments(chip, lastContext);
    expect(text).toContain("372K available");
    expect(input.context_window.used_percentage).toBe(0);
  });

  it("does not report 0% until auto-compact while used context sits below the threshold", () => {
    // Observed state 2: last request context 306_551 input-side + 20_000
    // output = 326_551 used of 372_000 (88% used, 45K available). The live
    // turn meter sat at 152_800 (streamed chars of earlier rounds already
    // inside the input count, plus subagent output that never enters the
    // main context).
    const lastContext = {
      inputTokens: 6_551,
      outputTokens: 20_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 300_000,
    };
    const chip = derive({ lastContext });
    const { text } = statuslineUsedSegments(chip, lastContext);
    expect(text).toContain("45K available");
    expect(text).toContain("88% used");

    // 326_551 of the 334_800 threshold leaves 2% — not 0%, which would claim
    // the auto-compact trigger point (computed from the same usage snapshot)
    // has been reached.
    expect(chip.autoCompactWarningPct).toBe(2);
    // The "N tokens" figure must equal the used total behind "88% used",
    // never a phantom total beyond the 372_000 window.
    expect(chip.activeContextTotal).toBe(326_551);
  });

  it("shows no auto-compact warning while used context is far from the threshold", () => {
    // Observed state 1: 85_600 used of 372_000 (23% used, 286K available)
    // rendered next to "25% until auto-compact · 249947 tokens" because the
    // live turn meter (164_347) was added on top of the context total.
    const lastContext = {
      inputTokens: 5_600,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 80_000,
    };
    const chip = derive({ lastContext });
    const { text } = statuslineUsedSegments(chip, lastContext);
    expect(text).toContain("286K available");
    expect(text).toContain("23% used");

    expect(chip.autoCompactWarningPct).toBeUndefined();
    expect(chip.activeContextTotal).toBe(85_600);
  });
});
