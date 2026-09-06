import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "@/kernel/config/config.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { StringContainer } from "@/terminal-runtime/string-view/component.js";
import { StringViewAgentDocument } from "@/ui/app/string-view-agent-document.ts";
import { StringViewRoot } from "@/ui/app/string-view-root.ts";
import { ctrlXChordArmed, releaseCtrlXChord } from "@/ui/input/ctrl-x-chord.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";
import { StringViewOverlayHost } from "@/ui/panels/string-view-overlay-host.ts";
import { StringViewDetailedTranscript } from "@/ui/transcript/string-view-detailed-transcript.ts";
import { StringViewTranscript } from "@/ui/transcript/string-view-transcript.ts";

let initialAppState = appStore.getState();
const mountedRoots: StringViewRoot[] = [];
let configDir: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  initialAppState = appStore.getState();
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "otherside-strip-keys-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
});

function mountedRoot(): StringViewRoot {
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
  });
  mountedRoots.push(root);
  return root;
}

function focusStrip(): void {
  dispatch({ type: "view/setPanelFocused", focused: true });
}

const CTRL_X = { name: "x", ctrl: true } as KeyEventData;
const CTRL_E = { name: "e", ctrl: true } as KeyEventData;
const CTRL_T = { name: "t", ctrl: true } as KeyEventData;
const PLAIN_E = { name: "e", sequence: "e" } as KeyEventData;

afterEach(() => {
  for (const root of mountedRoots) root.unmount();
  mountedRoots.length = 0;
  releaseCtrlXChord();
  appStore.setState(() => initialAppState);
  if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

describe("a focused strip holds back typing, not gestures", () => {
  test("bare typing stays out of the prompt", () => {
    const root = mountedRoot();
    focusStrip();

    expect(root.handleKey(PLAIN_E)).toBe(true);
  });

  test("Ctrl+E passes through so it can finish the Ctrl+X prefix", () => {
    const root = mountedRoot();
    focusStrip();

    expect(root.handleKey(CTRL_X)).toBe(true);
    // The root declines the key: the prompt behind it claims the chord.
    expect(root.handleKey(CTRL_E)).toBe(false);
    // The prefix is still pending when the prompt gets its turn.
    expect(ctrlXChordArmed()).toBe(true);
  });

  test("a modified key still reaches the handlers below the strip", async () => {
    const root = mountedRoot();
    const expanded = appStore.getState().view.tasksExpanded;
    focusStrip();
    const configWrite = spyOn(config, "updateConfig");

    try {
      expect(root.handleKey(CTRL_T)).toBe(true);
      expect(appStore.getState().view.tasksExpanded).toBe(!expanded);
      expect(configWrite).toHaveBeenCalledTimes(1);
    } finally {
      const pendingWrite = configWrite.mock.results[0]?.value;
      configWrite.mockRestore();
      await pendingWrite;
    }
    expect(config.loadConfigSync().global?.taskListExpanded).toBe(!expanded);
  });
});
