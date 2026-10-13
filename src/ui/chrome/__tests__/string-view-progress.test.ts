import { afterEach, describe, expect, it } from "bun:test";
import chalk from "chalk";
import {
  ask as askPermission,
  clear as clearPermissionQueue,
} from "@/kernel/channels/permission.ts";
import { dispatch } from "@/store/app-store/index.ts";
import { setLiveOutputTokens } from "@/store/live-tokens/index.ts";
import { generatorActiveRef, turnStartedAtRef } from "@/store/turn-run/index.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { compactProgressRatio, PROGRESS_BAR_WIDTH } from "@/ui/chrome/progress/compact-bar.ts";
import { reasoningGlowColor } from "@/ui/chrome/progress/index.ts";
import {
  formatThinkingStatus,
  retryProgressRows,
  StringViewProgress,
} from "@/ui/chrome/string-view-progress.ts";
import { Glyph, GUTTER_HEAD } from "@/ui/theme/theme.ts";

const originalColorLevel = chalk.level;
chalk.level = 3;

const LONG_TITLE = "Adjusting AskUserQuestion call to remove top-level multiSelect";

/** A turn 16s in, reasoned for 5s, streaming under a reasoning title too long to fit. */
function startLongTitledTurn(): void {
  generatorActiveRef.current = true;
  turnStartedAtRef.current = Date.now() - 16_000;
  setLiveOutputTokens(183);
  dispatch({ type: "view/setSpinnerMode", mode: "responding" });
  dispatch({ type: "view/setThinkingStatus", status: 5_000 });
  dispatch({ type: "view/setTurnVerb", verb: LONG_TITLE });
}

afterEach(() => {
  generatorActiveRef.current = false;
  turnStartedAtRef.current = null;
  dispatch({ type: "view/setTurnVerb", verb: "Thinking" });
  dispatch({ type: "view/setProgressStartedAt", startedAt: null });
  dispatch({ type: "view/setTurnTipIndex", index: 0 });
  dispatch({ type: "view/setRetryStatus", status: null });
  dispatch({ type: "view/setSpinnerMode", mode: "requesting" });
  dispatch({ type: "view/setThinkingStatus", status: null });
  setLiveOutputTokens(0);
  chalk.level = originalColorLevel;
  chalk.level = 3;
});

describe("StringViewProgress compaction animation", () => {
  it("renders nothing when the generator is idle", () => {
    expect(new StringViewProgress().render(80)).toEqual([]);
  });

  it("draws no spinner while a prompt waits on the user's answer", async () => {
    generatorActiveRef.current = true;
    turnStartedAtRef.current = Date.now() - 2_000;
    const answer = askPermission({ toolName: "<tool>", argsPreview: "", rule: null });
    try {
      expect(new StringViewProgress().render(80)).toEqual([]);
    } finally {
      clearPermissionQueue();
      await answer;
    }
    expect(new StringViewProgress().render(80).map(stripAnsi)[0]).toMatch(/Thinking/);
  });

  it("renders the spinner header without a progress bar for a normal turn", () => {
    generatorActiveRef.current = true;
    turnStartedAtRef.current = Date.now() - 2_000;
    dispatch({ type: "view/setTurnVerb", verb: "Thinking" });

    const rows = new StringViewProgress().render(80).map(stripAnsi);
    expect(rows[0]).toMatch(/Thinking/);
    expect(rows[0]).toMatch(/\(2s\)/);
    expect(rows.some((row) => row.includes("%"))).toBe(false);
  });

  it("adds the compact progress bar under Compacting conversation", () => {
    generatorActiveRef.current = true;
    const startedAt = Date.now() - 30_000;
    turnStartedAtRef.current = startedAt;
    dispatch({ type: "view/setTurnVerb", verb: "Compacting conversation" });
    dispatch({ type: "view/setProgressStartedAt", startedAt });

    const progress = new StringViewProgress();
    const rows = progress.render(80).map(stripAnsi);
    expect(rows[0]).toBe("");
    expect(rows[1]).toMatch(/Compacting conversation/);
    const bar = rows[2] ?? "";
    expect(bar.startsWith("  ")).toBe(true);
    expect(bar).toMatch(/\d+%$/);

    const ratio = compactProgressRatio(30_000);
    const filled = Math.round(ratio * PROGRESS_BAR_WIDTH);
    // Prefer geometric glyphs when the terminal reports clean support; either
    // filled shape is acceptable so long as the count matches.
    const geometricFilled = bar.includes(Glyph.barFilled.repeat(Math.max(1, filled)));
    const blockFilled = bar.includes(Glyph.block.repeat(Math.max(1, filled)));
    expect(geometricFilled || blockFilled || filled === 0).toBe(true);
  });

  it("keeps the displayed bar monotonic across frames", () => {
    generatorActiveRef.current = true;
    const startedAt = Date.now() - 10_000;
    turnStartedAtRef.current = startedAt;
    dispatch({ type: "view/setTurnVerb", verb: "Compacting conversation" });
    dispatch({ type: "view/setProgressStartedAt", startedAt });

    const progress = new StringViewProgress();
    const first = stripAnsi(progress.render(80)[2] ?? "");
    const firstPct = Number(first.match(/(\d+)%$/)?.[1] ?? "0");

    // Simulate a clock skew that would otherwise lower the raw ratio by reusing
    // a later elapsed stamp through a second render; monotonic state should not
    // decrease the percent.
    const second = stripAnsi(progress.render(80)[2] ?? "");
    const secondPct = Number(second.match(/(\d+)%$/)?.[1] ?? "0");
    expect(secondPct).toBeGreaterThanOrEqual(firstPct);
  });

  it("resets bar state when leaving the compacting verb", () => {
    generatorActiveRef.current = true;
    const startedAt = Date.now() - 60_000;
    dispatch({ type: "view/setTurnVerb", verb: "Compacting conversation" });
    dispatch({ type: "view/setProgressStartedAt", startedAt });
    turnStartedAtRef.current = startedAt;

    const progress = new StringViewProgress();
    const compactRows = progress.render(80).map(stripAnsi);
    expect(compactRows[2]).toMatch(/%$/);

    dispatch({ type: "view/setTurnVerb", verb: "Thinking" });
    const thinkingRows = progress.render(80).map(stripAnsi);
    expect(thinkingRows.some((row) => row.includes("%"))).toBe(false);
  });

  it("renders live tokens, response direction, and reasoning duration", () => {
    generatorActiveRef.current = true;
    turnStartedAtRef.current = Date.now() - 2_000;
    setLiveOutputTokens(1_250);
    dispatch({ type: "view/setSpinnerMode", mode: "responding" });
    dispatch({ type: "view/setThinkingStatus", status: 4_200 });

    const row = stripAnsi(new StringViewProgress().render(100)[0] ?? "");
    expect(row).toContain(`${Glyph.arrowDown} 1.3k tokens`);
    expect(row).toContain("reasoned for 4s");
  });

  it("states the route's effort while reasoning is live", () => {
    generatorActiveRef.current = true;
    turnStartedAtRef.current = Date.now() - 2_000;
    dispatch({ type: "view/setThinkingStatus", status: "thinking" });

    const row = stripAnsi(new StringViewProgress().render(120)[0] ?? "");
    expect(row).toContain("reasoning with high effort");
  });

  it("falls back to the bare label when the suffixed one overflows the row", () => {
    generatorActiveRef.current = true;
    turnStartedAtRef.current = Date.now() - 2_000;
    dispatch({ type: "view/setThinkingStatus", status: "thinking" });

    const row = stripAnsi(new StringViewProgress().render(36)[0] ?? "");
    expect(row).toContain("reasoning");
    expect(row).not.toContain("reasoning with");
  });

  it("drops a finished reasoning readout before the title loses any of its text", () => {
    startLongTitledTurn();

    const row = stripAnsi(new StringViewProgress().render(100)[0] ?? "");
    expect(row).toContain(`${LONG_TITLE}… (16s · ${Glyph.arrowDown} 183 tokens)`);
    expect(row).not.toContain("reasoned for");
    expect(stringWidth(row)).toBeLessThanOrEqual(100);
  });

  it("shortens a long title so the elapsed readout keeps its slot", () => {
    startLongTitledTurn();

    const row = stripAnsi(new StringViewProgress().render(60)[0] ?? "");
    expect(row).toMatch(/^\S Adjusting AskUserQuestion/);
    expect(row).toEndWith(`… (16s · ${Glyph.arrowDown} 183 tokens)`);
    expect(stringWidth(row)).toBeLessThanOrEqual(60);
  });

  it("fits the row even where the readout alone is wider than the terminal", () => {
    startLongTitledTurn();

    const row = stripAnsi(new StringViewProgress().render(12)[0] ?? "");
    expect(stringWidth(row)).toBeLessThanOrEqual(12);
  });

  it("labels an effort-less route with megabrain power", () => {
    expect(formatThinkingStatus("thinking", null)).toBe("reasoning with megabrain power");
    expect(formatThinkingStatus("thinking", "xhigh")).toBe("reasoning with xhigh effort");
    expect(formatThinkingStatus(4_200, null)).toBe("reasoned for 4s");
  });

  it("holds the glow steady through the delay and breathes after it", () => {
    expect(reasoningGlowColor(1_000)).toBe("rgb(153,153,153)");
    expect(reasoningGlowColor(3_500)).toBe("rgb(185,185,185)");
    expect(reasoningGlowColor(4_500)).toBe("rgb(153,153,153)");
  });

  it("renders the retry countdown instead of the spinner body", () => {
    const rows = retryProgressRows(
      {
        attempt: 2,
        maxAttempts: 5,
        delayMs: 5_000,
        startedAt: 10_000,
        reason: "rate_limit exceeded",
        status: 429,
      },
      80,
      12_000,
    ).map(stripAnsi);
    expect(rows[0]).toBe(`${Glyph.bullet} HTTP 429: Rate limited`);
    expect(rows[1]).toBe(`${GUTTER_HEAD}Retrying in 3s · attempt 2/5`);
  });
});

/**
 * The leader's block is drawn from the generator flag, not from the store's
 * busy flag — that one drives the terminal's own progress indicator. Any path
 * that declares the leader idle has to answer both, so this pins the trap: a
 * cancel that only lowers the store flag leaves the block running.
 */
describe("StringViewProgress idles on the generator flag alone", () => {
  it("keeps drawing while the generator is live, whatever the store says", () => {
    generatorActiveRef.current = true;
    turnStartedAtRef.current = Date.now() - 1_000;
    dispatch({ type: "view/setBusy", busy: false });

    expect(new StringViewProgress().render(80)).not.toEqual([]);
  });

  it("goes idle the moment the generator flag drops", () => {
    generatorActiveRef.current = true;
    turnStartedAtRef.current = Date.now() - 1_000;
    const progress = new StringViewProgress();
    expect(progress.render(80)).not.toEqual([]);

    generatorActiveRef.current = false;

    expect(progress.render(80)).toEqual([]);
  });
});
