import { afterEach, describe, expect, it } from "bun:test";
import { transcriptActions } from "@/store/transcript/index.ts";
import { transcriptLiveActions } from "@/store/transcript/live.ts";
import { StringContainer } from "@/terminal-runtime/string-view/component.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { StringViewAgentDocument } from "@/ui/app/string-view-agent-document.ts";
import { StringViewRoot } from "@/ui/app/string-view-root.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";
import { StringViewDetailedTranscript } from "@/ui/transcript/string-view-detailed-transcript.ts";
import { StringViewTranscript } from "@/ui/transcript/string-view-transcript.ts";

const WIDTH = 80;
const PANEL_ROW = "panel owns the screen";
const PROMPT_MARK = "\u276f";

/** Stands in for the overlay host so the frame claim can be toggled directly. */
class StubPanelSource {
  claiming = false;

  isFullscreen(): boolean {
    return this.claiming;
  }

  render(): string[] {
    return [PANEL_ROW];
  }
}

function mountedRoot(): { root: StringViewRoot; source: StubPanelSource } {
  const transcript = new StringViewTranscript();
  const prompt = new StringViewPrompt();
  const promptScreen = new StringContainer();
  promptScreen.addChild(prompt);
  const source = new StubPanelSource();
  const root = new StringViewRoot(
    promptScreen,
    prompt,
    transcript,
    new StringViewDetailedTranscript(transcript),
    new StringViewAgentDocument(),
    source,
  );
  root.mount({
    requestRender: () => {},
    pushFocus: () => {},
    popFocus: () => {},
    currentFocus: () => prompt,
    terminalRows: () => 24,
  });
  return { root, source };
}

afterEach(() => {
  transcriptLiveActions.reset();
  transcriptActions.replace([]);
});

describe("a panel that claims the whole frame", () => {
  it("leaves the prompt on screen while it claims nothing", () => {
    const { root } = mountedRoot();

    const frame = root.render(WIDTH).map(stripAnsi).join("\n");

    expect(frame).toContain(PROMPT_MARK);
    expect(frame).not.toContain(PANEL_ROW);
  });

  it("renders alone, without the prompt beneath it", () => {
    const { root, source } = mountedRoot();
    source.claiming = true;

    const frame = root.render(WIDTH).map(stripAnsi).join("\n");

    expect(frame).toBe(PANEL_ROW);
    expect(frame).not.toContain(PROMPT_MARK);
  });

  it("parks the caret so nothing points at a prompt that is not drawn", () => {
    const { root, source } = mountedRoot();
    source.claiming = true;
    root.render(WIDTH);

    expect(root.caret(WIDTH)).toBeNull();
  });

  it("owns no settled history while it holds the frame", () => {
    const { root, source } = mountedRoot();
    source.claiming = true;

    expect(root.snapshotScrollback(WIDTH)).toEqual([]);
  });

  it("regenerates the surface when it lets the frame go", () => {
    const { root, source } = mountedRoot();
    root.takeScrollbackBatch(WIDTH);

    source.claiming = true;
    expect(root.takeScrollbackBatch(WIDTH).mode).toBe("switch");

    // Letting go is the moment the conversation has to be re-established: the
    // rows left the screen while the panel held it, so an incremental batch
    // would hand back nothing.
    source.claiming = false;
    expect(root.takeScrollbackBatch(WIDTH).mode).toBe("switch");
  });
});
