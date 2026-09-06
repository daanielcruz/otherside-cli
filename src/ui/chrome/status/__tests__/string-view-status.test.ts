import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { setTaskOutputSession } from "@/engine/background/tasks/output-files.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { clearActiveGoal, setActiveGoal } from "@/engine/queue/state.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import {
  RightNoticeKey,
  removeNotice,
  submitClipboardImageHint,
  submitEphemeral,
  submitMcpFailuresNotice,
  submitQuotaWarning,
  upsertPersistent,
} from "@/store/app-store/right-region-notices.ts";
import {
  promptStore,
  setPromptBashMode,
  setPromptNotice,
  setPromptPasteExpandHint,
  setPromptSearch,
} from "@/store/prompt/index.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { resetOrchestrationNoticeState } from "@/ui/chrome/status/line-input.ts";
import { statusLineRefreshMs } from "@/ui/chrome/status/string-view-right-region.ts";
import { StringViewStatusBar } from "@/ui/chrome/status/string-view-status-bar.ts";
import { StringViewStatusLine } from "@/ui/chrome/status/string-view-status-line.ts";
import { StringViewChromeRegion } from "@/ui/chrome/string-view-chrome-region.ts";
import { BREATH_FRAME_MS, breathingGrey } from "@/ui/theme/color-pulse.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

/** One full breath, sampled per millisecond so no reachable shade is missed. */
const BREATH_SWEEP_MS = 2_000;

const originalColorLevel = chalk.level;
const initialAppState = appStore.getState();
const initialPromptState = promptStore.getState();
const broker: BrokerState = {
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
  fastMode: true,
  permissionMode: "yolo",
  orchestrationMode: "disabled",
};

beforeAll(() => {
  chalk.level = 3;
  registerAllProviders();
});

beforeEach(() => {
  appStore.setState(() => initialAppState);
  promptStore.setState(() => initialPromptState);
  dispatch({ type: "engine/setSlice", key: "broker", value: broker });
  dispatch({
    type: "usage/setMainLastContext",
    value: {
      inputTokens: 100_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  });
});

afterEach(() => {
  appStore.setState(() => initialAppState);
  promptStore.setState(() => initialPromptState);
  resetOrchestrationNoticeState();
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

describe("StringViewStatusLine", () => {
  it("renders provider, model, available context, and used context; effort rides the promptbar badge", () => {
    const [line] = new StringViewStatusLine().render(100);

    expect(stripAnsi(line ?? "")).toBe("  [Codex] GPT-5.6 Sol Fast · 272K available · 27% used");
    expect(line).toContain(renderTextWithStyles("Fast", { color: Color.fastMode, bold: true }));
  });

  it("subscribes to broker and usage changes and unsubscribes on teardown", () => {
    const line = new StringViewStatusLine();
    let renders = 0;
    line.mount({ requestRender: () => renders++, pushFocus: () => {}, popFocus: () => {} });
    expect(renders).toBe(1);

    dispatch({ type: "usage/setMainLastContext", value: initialAppState.usage.mainLastContext });
    expect(renders).toBe(2);
    line.unmount();
    dispatch({ type: "engine/setSlice", key: "broker", value: broker });
    expect(renders).toBe(2);
  });

  it("expires quota warnings at their deadline", async () => {
    const line = new StringViewStatusLine();
    line.mount({ requestRender() {}, pushFocus() {}, popFocus() {} });
    submitEphemeral({
      key: "quota-warning",
      text: "70% Usage · resets soon",
      tone: "warning",
      priority: "high",
      durationMs: 5,
    });

    expect(stripAnsi(line.render(120)[0] ?? "")).toContain("70% Usage");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stripAnsi(line.render(120)[0] ?? "")).not.toContain("70% Usage");
    line.unmount();
  });

  it("lets a transient warning take the side from the persistent readout", () => {
    dispatch({ type: "rightRegion/setCounter", text: "1200 tokens" });
    const line = new StringViewStatusLine();

    const before = line.render(120).map(stripAnsi);
    expect(before).toHaveLength(1);
    expect(before[0]).toContain("1200 tokens");

    submitQuotaWarning("weekly limit reached", "warning");
    const rows = line.render(120).map(stripAnsi);

    // Still one row: the warning owns the side while it lives, and the readout
    // comes back when it expires rather than being stacked under it.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("[Codex] GPT-5.6 Sol");
    expect(rows[0]).toContain("weekly limit reached");
    expect(rows[0]).not.toContain("1200 tokens");
  });

  it("keeps voice on the side alone", () => {
    dispatch({ type: "rightRegion/setCounter", text: "1200 tokens" });
    const line = new StringViewStatusLine();
    submitEphemeral({
      key: "voice-recording",
      text: "listening…",
      tone: "muted",
      priority: "immediate",
      durationMs: null,
    });
    const rows = line.render(120).map(stripAnsi);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("listening…");
    expect(rows[0]).not.toContain("1200 tokens");
  });

  it("renders voice processing alone with a breathing grey and pulse refresh", () => {
    dispatch({ type: "rightRegion/setCounter", text: "1200 tokens" });
    submitEphemeral({
      key: RightNoticeKey.voiceProcessing,
      text: "Voice: processing…",
      tone: "muted",
      priority: "immediate",
      durationMs: null,
    });
    const line = new StringViewStatusLine();
    const rows = line.render(120).map(stripAnsi);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Voice: processing…");
    expect(rows[0]).not.toContain("1200 tokens");
    expect(statusLineRefreshMs(appStore.getState())).toBe(BREATH_FRAME_MS);

    // The label breathes: its grey is driven by the clock rather than fixed by the
    // theme. Asserting it merely differs from the theme's grey would be a coin toss,
    // because the sweep passes through that exact value once per cycle.
    const styled = line.render(120)[0] ?? "";
    const painted = /\x1b\[38;2;(\d+);(\d+);(\d+)m[^\x1b]*Voice: processing…/.exec(styled);
    expect(painted).not.toBeNull();
    const [red, green, blue] = (painted ?? []).slice(1).map(Number);
    // A grey, so the three channels agree, and inside the span the breath sweeps.
    expect(green).toBe(red);
    expect(blue).toBe(red);
    const sweep = Array.from({ length: BREATH_SWEEP_MS }, (_, ms) =>
      Number.parseInt(breathingGrey(ms).slice(1, 3), 16),
    );
    expect(red).toBeGreaterThanOrEqual(Math.min(...sweep));
    expect(red).toBeLessThanOrEqual(Math.max(...sweep));
  });

  it("renders voice error alone in the error tone", () => {
    dispatch({ type: "rightRegion/setCounter", text: "1200 tokens" });
    submitEphemeral({
      key: RightNoticeKey.voiceError,
      text: "mic unavailable",
      tone: "error",
      priority: "immediate",
      durationMs: 10_000,
    });
    const line = new StringViewStatusLine();
    const rows = line.render(120);

    expect(rows.map(stripAnsi)).toHaveLength(1);
    expect(stripAnsi(rows[0] ?? "")).toContain("mic unavailable");
    expect(stripAnsi(rows[0] ?? "")).not.toContain("1200 tokens");
    expect(rows[0]).toContain(renderTextWithStyles("mic unavailable", { color: Color.error }));
  });

  it("renders MCP boot failures in the error tone with a dim command hint", () => {
    dispatch({ type: "rightRegion/setCounter", text: "1200 tokens" });
    submitMcpFailuresNotice(2);
    const line = new StringViewStatusLine();
    const rows = line.render(120);

    expect(rows.map(stripAnsi)).toHaveLength(1);
    expect(stripAnsi(rows[0] ?? "")).toContain("2 MCP servers failed · /mcp");
    expect(stripAnsi(rows[0] ?? "")).not.toContain("1200 tokens");
    expect(rows[0]).toContain(renderTextWithStyles("2 MCP servers failed", { color: Color.error }));
    expect(rows[0]).toContain(renderTextWithStyles(" · /mcp", { color: Color.error, dim: true }));
  });

  it("drops the dim command hint before truncating the message on a tight budget", () => {
    submitMcpFailuresNotice(1);
    const line = new StringViewStatusLine();
    // Right lane budget is 22 here: the message (19) fits, message + hint (26) does not.
    const [row] = line.render(50);

    expect(stripAnsi(row ?? "")).toContain("1 MCP server failed");
    expect(stripAnsi(row ?? "")).not.toContain("/mcp");
  });

  it("announces the orchestration mode once at startup and again on a switch", () => {
    resetOrchestrationNoticeState();
    dispatch({
      type: "engine/setSlice",
      key: "broker",
      value: { ...broker, orchestrationMode: "default" },
    });
    const line = new StringViewStatusLine();

    // The first paint observes the startup mode and submits; the notice rides
    // the same row's right lane in the warning tone from the next paint on.
    line.render(120);
    const startup = line.render(120)[0] ?? "";
    expect(stripAnsi(startup)).toContain("Multiprovider orchestration is active in default mode");
    expect(startup).toContain(
      renderTextWithStyles("Multiprovider orchestration is active in default mode", {
        color: Color.warning,
      }),
    );

    // Repeated paints of the same mode never re-announce.
    removeNotice(RightNoticeKey.orchestration);
    expect(stripAnsi(line.render(120)[0] ?? "")).not.toContain("Multiprovider orchestration");

    // A real switch announces once more.
    dispatch({
      type: "engine/setSlice",
      key: "broker",
      value: { ...broker, orchestrationMode: "disabled" },
    });
    line.render(120);
    expect(stripAnsi(line.render(120)[0] ?? "")).toContain("Multiprovider orchestration disabled");
  });
});

describe("StringViewStatusBar", () => {
  it("renders the permission chip and cycle hint", () => {
    const [line] = new StringViewStatusBar().render(80);

    expect(stripAnsi(line ?? "")).toBe(
      `  ${Glyph.fastForward.repeat(2)} yolo mode on (shift+tab to cycle)`,
    );
    expect(line).toContain(
      renderTextWithStyles(`${Glyph.fastForward.repeat(2)} `, {
        color: Color.modeYolo,
        bold: true,
      }),
    );
  });

  it("right-aligns the statusbar-lane session notice beside the permission chip", () => {
    upsertPersistent({
      key: RightNoticeKey.remote,
      text: "Remote Session active",
      lane: "statusbar",
      tone: "success",
      priority: "high",
      bold: true,
    });
    const [line] = new StringViewStatusBar().render(100);
    const plain = stripAnsi(line ?? "");

    expect(plain).toContain("yolo mode on");
    expect(plain).toContain("Remote Session active");
    expect(plain.indexOf("yolo mode on")).toBeLessThan(plain.indexOf("Remote Session active"));
    expect(line).toContain(
      renderTextWithStyles("Remote Session active", {
        color: Color.success,
        bold: true,
      }),
    );
  });

  it("right-aligns the design session notice with the design tone", () => {
    upsertPersistent({
      key: RightNoticeKey.design,
      text: "Design session active",
      lane: "statusbar",
      tone: "design",
      priority: "medium",
      bold: true,
    });
    const [line] = new StringViewStatusBar().render(100);
    const plain = stripAnsi(line ?? "");

    expect(plain).toContain("Design session active");
    expect(line).toContain(
      renderTextWithStyles("Design session active", {
        color: Color.designSession,
        bold: true,
      }),
    );
  });

  it("uses the plan and accept-edits chip vocabulary and colors", () => {
    for (const [permissionMode, symbol, label, color] of [
      ["plan", Glyph.pause, "plan mode on", Color.modePlan],
      ["accept-edits", Glyph.fastForward.repeat(2), "accept edits on", Color.modeAccept],
    ] as const) {
      dispatch({
        type: "engine/setSlice",
        key: "broker",
        value: { ...broker, permissionMode },
      });
      const [line] = new StringViewStatusBar().render(80);
      expect(stripAnsi(line ?? "")).toBe(`  ${symbol} ${label} (shift+tab to cycle)`);
      expect(line).toContain(renderTextWithStyles(`${symbol} `, { color, bold: true }));
    }
  });

  it("uses prompt search and bash-mode left-slot precedence reactively", () => {
    const bar = new StringViewStatusBar();
    let renders = 0;
    bar.mount({ requestRender: () => renders++, pushFocus: () => {}, popFocus: () => {} });
    expect(renders).toBe(1);

    setPromptBashMode(true);
    expect(stripAnsi(bar.render(80)[0] ?? "")).toBe("  ! for shell mode");
    setPromptSearch({ query: "deploy", failed: false, scope: "everywhere" });
    expect(stripAnsi(bar.render(80)[0] ?? "")).toBe("  search prompts (everywhere): deploy ");
    expect(renders).toBe(3);

    bar.unmount();
    setPromptSearch(null);
    expect(renders).toBe(3);
  });

  it("lets the paste-expand hint temporarily take over the left slot", () => {
    setPromptBashMode(true);
    setPromptPasteExpandHint(true);

    const [line] = new StringViewStatusBar().render(80);

    expect(stripAnsi(line ?? "")).toBe("  paste again to expand");
    expect(line).toContain(
      renderTextWithStyles("paste again to expand", { color: Color.muted, dim: true }),
    );
  });

  it("gives the prompt's transient notice the left slot ahead of the standing chips", () => {
    setPromptBashMode(true);
    setPromptPasteExpandHint(true);
    setPromptNotice("prompt stashed · ctrl+s to restore");

    const [line] = new StringViewStatusBar().render(80);

    expect(stripAnsi(line ?? "")).toBe("  prompt stashed · ctrl+s to restore");
    expect(line).toContain(
      renderTextWithStyles("prompt stashed · ctrl+s to restore", { color: Color.muted }),
    );

    setPromptNotice(null);
    expect(stripAnsi(new StringViewStatusBar().render(80)[0] ?? "")).toBe(
      "  paste again to expand",
    );
  });
});

describe("the two right-hand lanes", () => {
  const SESSION = "session-lanes";

  beforeEach(() => {
    setTaskOutputSession({ sessionId: SESSION, cwd: process.cwd() });
  });

  afterEach(() => {
    clearActiveGoal(SESSION);
  });

  it("keeps a quota warning alone on the model row and off the mode row", () => {
    submitQuotaWarning("weekly limit in 2h", "warning");

    const [line] = new StringViewStatusLine().render(120);
    const [mode] = new StringViewStatusBar().render(120);

    expect(stripAnsi(line ?? "")).toContain("weekly limit in 2h");
    expect(stripAnsi(mode ?? "")).not.toContain("weekly limit in 2h");
  });

  it("puts the goal on the mode row, never on the model row", () => {
    setActiveGoal(SESSION, "ship the renderer");

    const [line] = new StringViewStatusLine().render(120);
    const [mode] = new StringViewStatusBar().render(120);

    expect(stripAnsi(mode ?? "")).toContain("/goal active");
    expect(stripAnsi(line ?? "")).not.toContain("/goal active");
  });

  it("splits the mode row between the clipboard hint and the goal", () => {
    setActiveGoal(SESSION, "ship the renderer");
    submitClipboardImageHint("Image in clipboard");

    const [mode] = new StringViewStatusBar().render(120);
    const text = stripAnsi(mode ?? "");

    expect(text).toContain("Image in clipboard");
    expect(text).toContain("/goal active");
    expect(text).toContain(" · ");
  });

  it("omits the separator when the hint rides the mode row alone", () => {
    submitClipboardImageHint("Image in clipboard");

    const [mode] = new StringViewStatusBar().render(120);
    const text = stripAnsi(mode ?? "");

    expect(text).toContain("Image in clipboard");
    expect(text).not.toContain(" · Image");
    expect(text).not.toContain("Image in clipboard · ");
  });

  it("never grows the chrome past its two rows", () => {
    setActiveGoal(SESSION, "ship the renderer");
    submitClipboardImageHint("Image in clipboard");
    dispatch({ type: "rightRegion/setCounter", text: "1200 tokens" });

    expect(new StringViewStatusLine().render(120)).toHaveLength(1);
    expect(new StringViewStatusBar().render(120)).toHaveLength(1);
  });
});

describe("StringViewChromeRegion", () => {
  it("renders status line before mode line and fans lifecycle to both", () => {
    const chrome = new StringViewChromeRegion();
    let renders = 0;
    chrome.mount({ requestRender: () => renders++, pushFocus: () => {}, popFocus: () => {} });
    const rows = chrome.render(100).map(stripAnsi);

    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("[Codex] GPT-5.6 Sol Fast");
    expect(rows[1]).toContain("yolo mode on");
    expect(rows[2]).toBe("");
    expect(rows[3]).toBe("");
    expect(renders).toBe(2);
    chrome.unmount();
  });
});
