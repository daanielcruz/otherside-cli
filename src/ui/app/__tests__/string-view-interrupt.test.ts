import { afterEach, describe, expect, test } from "bun:test";
import { appStore } from "@/store/app-store/index.ts";
import { runningRef } from "@/store/turn-run/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { StringContainer } from "@/terminal-runtime/string-view/component.js";
import { StringViewAgentDocument } from "@/ui/app/string-view-agent-document.ts";
import { StringViewRoot } from "@/ui/app/string-view-root.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";
import { StringViewOverlayHost } from "@/ui/panels/string-view-overlay-host.ts";
import { StringViewDetailedTranscript } from "@/ui/transcript/string-view-detailed-transcript.ts";
import { StringViewTranscript } from "@/ui/transcript/string-view-transcript.ts";

const initialAppState = appStore.getState();
const mountedRoots: StringViewRoot[] = [];

const ESCAPE = { name: "escape" } as KeyEventData;
const CTRL_C = { name: "c", ctrl: true } as KeyEventData;

function mountedRoot(cancelTurn: () => boolean): StringViewRoot {
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
    cancelTurn,
  );
  root.mount({
    requestRender: () => {},
    pushFocus: () => {},
    popFocus: () => {},
    currentFocus: () => prompt,
  });
  mountedRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of mountedRoots) root.unmount();
  mountedRoots.length = 0;
  runningRef.current = false;
  appStore.setState(() => initialAppState);
});

/**
 * A turn keeps `runningRef` raised while it unwinds, so the flag outlives the
 * guard the cancel path actually checks. The key must follow what happened, not
 * what the flag says: consuming a press that aborted nothing reads as a dead
 * keyboard and is why a stuck turn gets hammered with Escape.
 */
describe("interrupting a turn only claims the key when it aborts one", () => {
  test("escape is consumed when a turn was aborted", () => {
    let calls = 0;
    const root = mountedRoot(() => {
      calls += 1;
      return true;
    });
    runningRef.current = true;

    expect(root.handleKey(ESCAPE)).toBe(true);
    expect(calls).toBe(1);
  });

  test("escape falls through when there was no turn left to abort", () => {
    let calls = 0;
    const root = mountedRoot(() => {
      calls += 1;
      return false;
    });
    runningRef.current = true;

    expect(root.handleKey(ESCAPE)).toBe(false);
    expect(calls).toBe(1);
  });

  test("ctrl+c follows the same rule", () => {
    const root = mountedRoot(() => false);
    runningRef.current = true;

    expect(root.handleKey(CTRL_C)).toBe(false);
  });

  test("no interrupt is attempted while nothing is running", () => {
    let calls = 0;
    const root = mountedRoot(() => {
      calls += 1;
      return true;
    });

    root.handleKey(ESCAPE);
    expect(calls).toBe(0);
  });
});
