import { afterEach, describe, expect, test } from "bun:test";
import { transcriptActions } from "@/store/transcript/index.ts";
import { transcriptLiveActions } from "@/store/transcript/live.ts";
import { StringContainer } from "@/terminal-runtime/string-view/component.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { StringViewAgentDocument } from "@/ui/app/string-view-agent-document.ts";
import { StringViewRoot } from "@/ui/app/string-view-root.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";
import { StringViewOverlayHost } from "@/ui/panels/string-view-overlay-host.ts";
import { StringViewDetailedTranscript } from "@/ui/transcript/string-view-detailed-transcript.ts";
import { StringViewTranscript } from "@/ui/transcript/string-view-transcript.ts";

const WIDTH = 80;
const VIEWPORT_ROWS = 24;

function mountedRoot(terminalRows: number | undefined): {
  root: StringViewRoot;
  footerRowCount: number;
} {
  const transcript = new StringViewTranscript();
  const prompt = new StringViewPrompt();
  const promptScreen = new StringContainer();
  promptScreen.addChild(prompt);
  const root = new StringViewRoot(
    promptScreen,
    prompt,
    transcript,
    new StringViewDetailedTranscript(transcript),
    new StringViewAgentDocument(),
    new StringViewOverlayHost(),
  );
  root.mount({
    requestRender: () => {},
    pushFocus: () => {},
    popFocus: () => {},
    currentFocus: () => prompt,
    ...(terminalRows === undefined ? {} : { terminalRows: () => terminalRows }),
  });
  return { root, footerRowCount: promptScreen.render(WIDTH).length };
}

function streamLines(count: number): void {
  transcriptLiveActions.setStreamingId("stream_height_probe");
  transcriptLiveActions.setStreamingText(
    Array.from({ length: count }, (_, index) => `streamed line ${index}`).join("\n"),
  );
}

afterEach(() => {
  transcriptLiveActions.reset();
  transcriptActions.replace([]);
});

/**
 * The root's height ledger: a frame taller than the viewport physically scrolls,
 * freezing still-live rows into scrollback where the next paint draws them again
 * as ghost copies. The whole frame must therefore fit the terminal.
 */
describe("string-view root height ledger", () => {
  test("a live tail taller than the viewport is clipped from the head", () => {
    const { root } = mountedRoot(VIEWPORT_ROWS);
    streamLines(100);

    const frame = root.render(WIDTH);
    expect(frame.length).toBeLessThanOrEqual(VIEWPORT_ROWS);

    const text = frame.map(stripAnsi).join("\n");
    expect(text).toContain("streamed line 99");
    expect(text).not.toContain("streamed line 0\n");
  });

  test("the footer survives the clip in full, below the live tail", () => {
    const { root, footerRowCount } = mountedRoot(VIEWPORT_ROWS);
    streamLines(100);

    const frame = root.render(WIDTH);
    // The live region got exactly the viewport minus the footer, never more.
    expect(frame.length).toBe(VIEWPORT_ROWS);
    const liveRows = frame.length - footerRowCount;
    expect(liveRows).toBe(VIEWPORT_ROWS - footerRowCount);
    const lastLiveRow = stripAnsi(frame[liveRows - 1] ?? "");
    expect(lastLiveRow).toContain("streamed line 99");
  });

  test("a live tail within the budget stays whole", () => {
    const { root } = mountedRoot(VIEWPORT_ROWS);
    streamLines(3);

    const text = root.render(WIDTH).map(stripAnsi).join("\n");
    expect(text).toContain("streamed line 0");
    expect(text).toContain("streamed line 2");
  });

  test("a footer taller than the viewport clips from the head, keeping the tail", () => {
    const transcript = new StringViewTranscript();
    const prompt = new StringViewPrompt();
    const promptScreen = new StringContainer();
    promptScreen.addChild({
      render: () => Array.from({ length: VIEWPORT_ROWS + 10 }, (_, index) => `panel row ${index}`),
    });
    promptScreen.addChild(prompt);
    const root = new StringViewRoot(
      promptScreen,
      prompt,
      transcript,
      new StringViewDetailedTranscript(transcript),
      new StringViewAgentDocument(),
      new StringViewOverlayHost(),
    );
    root.mount({
      requestRender: () => {},
      pushFocus: () => {},
      popFocus: () => {},
      currentFocus: () => prompt,
      terminalRows: () => VIEWPORT_ROWS,
    });

    const frame = root.render(WIDTH);
    expect(frame.length).toBeLessThanOrEqual(VIEWPORT_ROWS);
    const text = frame.map(stripAnsi).join("\n");
    // The head is gone; the tail — where the actionable rows live — survives.
    expect(text).not.toContain("panel row 0\n");
    expect(text).toContain(`panel row ${VIEWPORT_ROWS + 9}`);
  });
});

describe("string-view root verbose seed", () => {
  test("boot seeds the live verbose state from config", async () => {
    const { appStore } = await import("@/store/app-store/index.ts");
    const { buildStringViewRoot } = await import("@/ui/app/string-view-root.ts");

    buildStringViewRoot({ verbose: true });
    expect(appStore.getState().view.verboseTranscript).toBe(true);

    // The last build leaves the store back at the default for later files.
    buildStringViewRoot({});
    expect(appStore.getState().view.verboseTranscript).toBe(false);
  });
});
