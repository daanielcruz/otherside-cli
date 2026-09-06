import { afterEach, describe, expect, test } from "bun:test";
import chalk from "chalk";
import {
  clear as clearBackgroundTasks,
  resetEmitThrottleForTests,
  startTask,
} from "@/engine/background/tasks/background.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import { transcriptActions } from "@/store/transcript/index.ts";
import { generatorActiveRef, turnStartedAtRef } from "@/store/turn-run/index.ts";
import { type StringComponent, StringContainer } from "@/terminal-runtime/string-view/component.js";
import { InlineRowPainter } from "@/terminal-runtime/string-view/row-emitter.js";
import { Spacer } from "@/terminal-runtime/string-view/spacer.js";
import { ERASE_LINE } from "@/terminal-runtime/terminal/control-sequences.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { StringViewChromeRegion } from "@/ui/chrome/string-view-chrome-region.ts";
import { StringViewProgress } from "@/ui/chrome/string-view-progress.ts";
import { StringViewQueue } from "@/ui/chrome/string-view-queue.ts";
import { StringViewRunningAgents } from "@/ui/chrome/string-view-running-agents.ts";
import { StringViewAutocomplete } from "@/ui/input/string-view-autocomplete.ts";
import { StringViewMentionPicker } from "@/ui/input/string-view-mention-picker.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";
import { PULSE_FRAME_MS, pulsedColor } from "@/ui/theme/color-pulse.ts";
import { Color } from "@/ui/theme/theme.ts";

/**
 * Why the footer churns. The emitter rewrites a contiguous span — from the first
 * changed row to the last — so two rows that animate on their own clocks at opposite
 * ends of the footer drag every row between them through the terminal, including the
 * queued-message preview, the promptbar and the status rows that did not change.
 * These tests measure both halves: which rows are non-deterministic, and what one
 * tick of them costs.
 */

const WIDTH = 100;
const HEIGHT = 40;

const initialAppState = appStore.getState();
const initialChalkLevel = chalk.level;

afterEach(() => {
  chalk.level = initialChalkLevel;
  generatorActiveRef.current = false;
  turnStartedAtRef.current = null;
  appStore.setState(() => initialAppState);
  clearBackgroundTasks();
  resetEmitThrottleForTests();
  transcriptActions.replace([]);
});

const NOOP_CONTEXT = {
  requestRender: (): void => {},
  pushFocus: (): void => {},
  popFocus: (): void => {},
  currentFocus: (): undefined => undefined,
};

interface RowDifference {
  row: number;
  before: string;
  after: string;
}

/**
 * Renders a component twice with nothing between the two calls but the passage of
 * time, and reports the rows whose bytes differ. A row listed here repaints without
 * any state having changed.
 */
async function rowsThatDifferAcrossRenders(
  component: StringComponent,
  gapMs: number,
): Promise<RowDifference[]> {
  component.mount?.(NOOP_CONTEXT);
  const before = component.render(WIDTH);
  await new Promise((resolve) => setTimeout(resolve, gapMs));
  const after = component.render(WIDTH);
  component.unmount?.();

  const differences: RowDifference[] = [];
  for (let row = 0; row < Math.max(before.length, after.length); row++) {
    const left = before[row] ?? "";
    const right = after[row] ?? "";
    if (left !== right) {
      differences.push({ row, before: stripAnsi(left), after: stripAnsi(right) });
    }
  }
  return differences;
}

/** The bottom region as `buildStringViewRoot` composes it, minus the modal surfaces. */
function bottomRegion(): StringContainer {
  const promptScreen = new StringContainer();
  const prompt = new StringViewPrompt();
  promptScreen.addChild(new Spacer(1));
  promptScreen.addChild(new StringViewProgress());
  promptScreen.addChild(new StringViewQueue());
  promptScreen.addChild(prompt);
  promptScreen.addChild(new StringViewAutocomplete(prompt));
  promptScreen.addChild(
    new StringViewMentionPicker(prompt, {
      loadFiles: async () => [],
      listAgents: () => [],
    }),
  );
  promptScreen.addChild(new StringViewChromeRegion());
  promptScreen.addChild(new StringViewRunningAgents());
  return promptScreen;
}

function startLiveTurn(): void {
  generatorActiveRef.current = true;
  turnStartedAtRef.current = Date.now();
  dispatch({ type: "view/setTurnVerb", verb: "Thinking" });
}

function startBackgroundAgent(): void {
  startTask({
    parentToolCallId: "call-1",
    agentName: "reviewer",
    agentId: "general-purpose",
    description: "audit the queue",
    isBackgrounded: true,
  });
}

/** Rows the emitter actually rewrote: it erases each row before repainting it. */
function rewrittenRowCount(bytes: string): number {
  return bytes.split(ERASE_LINE).length - 1;
}

describe("footer rows that repaint on their own clock", () => {
  test("the progress block's spinner row changes on every frame of a live turn", async () => {
    startLiveTurn();

    const differences = await rowsThatDifferAcrossRenders(new StringViewProgress(), 250);

    expect(differences.map((entry) => entry.row)).toEqual([0]);
    expect(differences[0]?.after).toContain("Thinking…");
  });

  test("a viewed agent's live turn drives the frame clock while the leader is idle", async () => {
    // The leader's generator stays off: the tick must answer for the agent
    // whose document is open, or its spinner freezes between store events.
    const task = startTask({
      parentToolCallId: "call-2",
      agentName: "runner",
      agentId: "general-purpose",
      description: "sleep quietly",
      isBackgrounded: true,
    });
    dispatch({ type: "view/setViewingAgent", id: task.id });

    const progress = new StringViewProgress();
    let repaints = 0;
    progress.mount({ ...NOOP_CONTEXT, requestRender: () => repaints++ });
    const spinnerRow = stripAnsi(progress.render(WIDTH)[0] ?? "");
    await new Promise((resolve) => setTimeout(resolve, 400));
    progress.unmount();

    expect(repaints).toBeGreaterThanOrEqual(2);
    expect(spinnerRow).toContain("Running…");
  });

  test("the running-agents row changes once its elapsed clock ticks", async () => {
    startBackgroundAgent();

    const differences = await rowsThatDifferAcrossRenders(new StringViewRunningAgents(), 1_100);

    expect(differences.map((entry) => entry.row)).toEqual([1]);
    expect(differences[0]?.before.trimEnd()).toEndWith("0s");
    expect(differences[0]?.after.trimEnd()).toEndWith("1s");
  });

  test("the status row is stable while nothing pulses", async () => {
    const differences = await rowsThatDifferAcrossRenders(new StringViewChromeRegion(), 250);

    expect(differences).toEqual([]);
  });

  test("the goal pulse rewrites the status row on a clock, without changing its text", () => {
    chalk.level = 3;

    // The pulse is a function of the wall clock alone, so every frame the status row
    // carries different colour bytes behind identical text — a repaint with nothing
    // to show for it. `statusRightRefreshMs` schedules one of these every 200ms for
    // as long as a goal is active.
    const frames = Array.from({ length: 4 }, (_, index) =>
      pulsedColor(Color.primary, index * PULSE_FRAME_MS),
    );

    expect(new Set(frames).size).toBeGreaterThan(1);
  });
});

describe("what one tick costs the footer", () => {
  test("re-emitting an unchanged frame writes nothing", () => {
    const emitter = new InlineRowPainter();
    const frame = ["", "> prompt", "status", "mode", ""];

    emitter.paintScrollback(["welcome"], frame, { width: WIDTH, height: HEIGHT });
    emitter.commitScrollback(["", "a tool ran"], frame, { width: WIDTH, height: HEIGHT });
    const { bytes } = emitter.emitFrame(frame, { width: WIDTH, height: HEIGHT });

    expect(bytes).toBe("");
  });

  test("two rows ticking at opposite ends cost only those two rows", async () => {
    startLiveTurn();
    startBackgroundAgent();
    const region = bottomRegion();
    region.mount(NOOP_CONTEXT);

    const emitter = new InlineRowPainter();
    const geometry = { width: WIDTH, height: HEIGHT };
    emitter.paintScrollback(["welcome"], region.render(WIDTH), geometry);
    // Long enough for the agent's elapsed clock (last row) to tick while the
    // spinner (first row) keeps animating.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const frame = region.render(WIDTH);
    const { bytes } = emitter.emitFrame(frame, geometry);
    region.unmount();

    // The spinner sits on the first row and the agent's elapsed clock on the last.
    // Only those two rows may be written: the cursor still travels the span between
    // them, but the rows it passes over keep whatever the terminal already holds.
    expect(frame.length).toBe(14);
    expect(rewrittenRowCount(bytes)).toBe(2);
  });
});
