import { beforeAll, describe, expect, it } from "bun:test";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { deriveChipUsage } from "@/engine/session/usage/chip-derive.ts";
import type { TokenTotals } from "@/engine/session/usage/provider.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { computeAutoCompactRemainingPct } from "@/ui/app/status-text.ts";
import { buildStatuslineInput, renderNativeStatusline } from "@/ui/chrome/status/line-input.ts";

// Both status-line surfaces must share one context counter: the
// "available/used" pair and the "% until auto-compact" / "N tokens" pair are
// rendered side by side from the same provider usage snapshot, so a divergence
// between them is a contract violation. Regression source: a live session on
// codex gpt-5.6-sol (window 372_000, compact threshold 334_800) showed
// "45K available · 88% used" next to "0% until auto-compact · 459351 tokens".

const MODEL = "gpt-5.6-sol";
const PROVIDER = "codex" as const;

const zeroTotals: TokenTotals = {
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

function derive(args: {
  lastContext: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
}) {
  return deriveChipUsage({
    mainLastContext: args.lastContext,
    mainTokenTotals: zeroTotals,
    provider: PROVIDER,
    model: MODEL,
    contextWarningSuppressed: false,
    fallbackContextTokens: 0,
    queuedText: "",
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
  });
  return { text: renderNativeStatusline(input), input };
}

describe("chip usage stays consistent with the available/used status surface", () => {
  beforeAll(() => registerAllProviders());

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
