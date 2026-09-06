import { afterEach, describe, expect, it } from "bun:test";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import type { AppState } from "@/store/app-store/types.ts";
import { setPromptText } from "@/store/prompt/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import {
  type StringComponent,
  StringContainer,
  type StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { StringFocusStack } from "@/terminal-runtime/string-view/focus.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { StringViewAgentDocument } from "@/ui/app/string-view-agent-document.ts";
import { StringViewRoot } from "@/ui/app/string-view-root.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";
import { StringViewOverlayHost } from "@/ui/panels/string-view-overlay-host.ts";
import {
  detailedTranscriptFooterText,
  StringViewDetailedTranscript,
} from "@/ui/transcript/string-view-detailed-transcript.ts";
import { StringViewTranscript } from "@/ui/transcript/string-view-transcript.ts";
import { transcriptInputAction } from "@/ui/transcript/string-view-transcript-input.ts";

const initialAppState: AppState = appStore.getState();
let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  appStore.setState(() => initialAppState);
  setPromptText("");
});

describe("StringViewDetailedTranscript", () => {
  it("pushes focus, windows to the latest 30, and toggles all", () => {
    const transcript = transcriptFixture(35);
    const reader = new StringViewDetailedTranscript(transcript);
    const { context, focus } = focusContext();
    reader.mount(context);
    cleanup = () => reader.unmount();

    dispatch({ type: "view/toggleTranscriptScreen" });
    expect(reader.isActive()).toBe(true);
    expect(focus.current()).toBe(reader);

    // The window opens on the newest rows of the latest-30 selection.
    const latest = plain(reader.render(80)).join("\n");
    expect(latest).not.toContain("entry-4");
    expect(latest).toContain("entry-34");
    expect(latest).toContain(detailedTranscriptFooterText(false));

    reader.handleKey(key("g"));
    const top = plain(reader.render(80)).join("\n");
    expect(top).toContain("entry-5");
    expect(top).not.toContain("entry-4");

    expect(reader.handleKey(key("e", true))).toBe(true);
    reader.handleKey(key("g"));
    const all = plain(reader.render(80)).join("\n");
    expect(all).toContain("entry-0");
    expect(all).toContain(detailedTranscriptFooterText(true));
  });

  it("resets show-all on Ctrl+O and every dedicated exit", () => {
    const exits = [key("o", true), key("escape"), key("c", true), key("q")];
    for (const exit of exits) {
      appStore.setState(() => initialAppState);
      const transcript = transcriptFixture(35);
      const reader = new StringViewDetailedTranscript(transcript);
      const { context, focus } = focusContext();
      reader.mount(context);

      dispatch({ type: "view/toggleTranscriptScreen" });
      reader.handleKey(key("e", true));
      expect(appStore.getState().view.showAllTranscriptMessages).toBe(true);
      reader.handleKey(exit);

      expect(appStore.getState().view).toMatchObject({
        transcriptScreen: "prompt",
        showAllTranscriptMessages: false,
      });
      expect(focus.current()).toBeUndefined();
      reader.unmount();
    }
  });

  it("pages the window with Ctrl+U and returns to the tail with G", () => {
    const reader = mountedReader();

    expect(plain(reader.render(80)).join("\n")).toContain("entry-34");

    expect(reader.handleKey(key("u", true))).toBe(true);
    expect(plain(reader.render(80)).join("\n")).not.toContain("entry-34");

    reader.handleKey(key("G"));
    expect(plain(reader.render(80)).join("\n")).toContain("entry-34");
  });

  it("opens an inline search row and parks the match on the first row", () => {
    const reader = mountedReader();
    reader.render(80);

    expect(reader.handleKey(key("/"))).toBe(true);
    for (const character of "entry-7") reader.handleKey(key(character));

    const rows = plain(reader.render(80));
    expect(rows.at(-2)).toContain("/entry-7");
    expect(rows[0]).toContain("entry-7");
  });

  it("uses the literal footer text for both states", () => {
    expect(detailedTranscriptFooterText(false)).toBe(
      "Showing detailed transcript · ctrl+o to toggle · ctrl+e to show all",
    );
    expect(detailedTranscriptFooterText(true)).toBe(
      "Showing detailed transcript · ctrl+o to toggle · ctrl+e to collapse",
    );
  });
});

describe("string-view transcript input ownership", () => {
  it("leaves Ctrl+E and q with the prompt outside detailed", () => {
    expect(transcriptInputAction(key("e", true), "prompt")).toBeNull();
    expect(transcriptInputAction(key("q"), "prompt")).toBeNull();
    expect(transcriptInputAction(key("o", true), "prompt")).toBe("toggle-screen");
  });

  it("routes transcript bindings only when prompt or reader owns focus", () => {
    const transcript = transcriptFixture(35);
    const prompt = new StringViewPrompt();
    const promptScreen = new StringContainer();
    const marker: StringComponent = { render: () => ["PROMPT SCREEN"] };
    promptScreen.addChild(marker);
    promptScreen.addChild(prompt);
    const reader = new StringViewDetailedTranscript(transcript);
    const root = new StringViewRoot(
      promptScreen,
      prompt,
      transcript,
      reader,
      new StringViewAgentDocument(),
      new StringViewOverlayHost(),
    );
    const { context, focus } = focusContext();
    root.mount(context);
    cleanup = () => root.unmount();

    const overlayKeys: string[] = [];
    const overlay = {
      handleKey: (input: KeyEventData) => {
        overlayKeys.push(`${input.ctrl ? "ctrl+" : ""}${input.name ?? ""}`);
      },
    };
    focus.push(overlay);
    expect(route(root, focus, key("o", true))).toBe(true);
    expect(appStore.getState().view.transcriptScreen).toBe("prompt");
    expect(overlayKeys).toEqual(["ctrl+o"]);

    focus.pop(overlay);
    expect(route(root, focus, key("e", true))).toBe(true);
    expect(appStore.getState().view.transcriptScreen).toBe("prompt");
    expect(route(root, focus, key("o", true))).toBe(true);
    expect(appStore.getState().view.transcriptScreen).toBe("detailed");
    expect(focus.current()).toBe(reader);
    // The reader takes the screen from the transcript, so the document it replaces is
    // erased rather than diffed — the one case that earns a destructive reset.
    expect(root.takeScrollbackBatch(80)).toEqual({ mode: "switch", rows: [] });
    expect(plain(root.render(80)).join("\n")).not.toContain("PROMPT SCREEN");

    focus.push(overlay);
    expect(route(root, focus, key("e", true))).toBe(true);
    expect(appStore.getState().view.showAllTranscriptMessages).toBe(false);
    expect(overlayKeys).toEqual(["ctrl+o", "ctrl+e"]);

    focus.pop(overlay);
    expect(route(root, focus, key("e", true))).toBe(true);
    expect(appStore.getState().view.showAllTranscriptMessages).toBe(true);
    expect(route(root, focus, key("q"))).toBe(true);
    expect(appStore.getState().view).toMatchObject({
      transcriptScreen: "prompt",
      showAllTranscriptMessages: false,
    });
    expect(focus.current()).toBe(prompt);
    // Handing the screen back is the same swap in reverse, so it erases too.
    expect(root.takeScrollbackBatch(80).mode).toBe("switch");
    expect(plain(root.render(80)).join("\n")).toContain("PROMPT SCREEN");
  });
});

function mountedReader(): StringViewDetailedTranscript {
  const reader = new StringViewDetailedTranscript(transcriptFixture(35));
  reader.mount(focusContext().context);
  cleanup = () => reader.unmount();
  dispatch({ type: "view/toggleTranscriptScreen" });
  return reader;
}

function transcriptFixture(count: number): StringViewTranscript {
  const transcript = new StringViewTranscript();
  transcript.setEntries(
    Array.from({ length: count }, (_, index) => ({
      kind: "system" as const,
      text: `entry-${index}`,
      isError: false,
    })),
  );
  return transcript;
}

function focusContext(): { context: StringViewContext; focus: StringFocusStack } {
  const focus = new StringFocusStack();
  return {
    focus,
    context: {
      requestRender: () => {},
      pushFocus: (target) => focus.push(target),
      popFocus: (target) => focus.pop(target),
      currentFocus: () => focus.current(),
    },
  };
}

function route(root: StringComponent, focus: StringFocusStack, input: KeyEventData): boolean {
  return root.handleKey?.(input) === true || focus.route(input);
}

function key(name: string, ctrl = false): KeyEventData {
  return {
    kind: "key",
    fn: false,
    name,
    ctrl,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: ctrl ? undefined : name,
    raw: undefined,
    isPasted: false,
  };
}

function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi);
}
