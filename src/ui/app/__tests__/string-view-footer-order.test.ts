import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clear as clearBackgroundTasks,
  resetEmitThrottleForTests,
  setForkId,
  startTask,
} from "@/engine/background/tasks/background.ts";
import { agentTranscriptPathForCwd } from "@/engine/session/paths.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import { transcriptActions } from "@/store/transcript/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { StringContainer } from "@/terminal-runtime/string-view/component.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { StringViewAgentDocument } from "@/ui/app/string-view-agent-document.ts";
import { buildStringViewRoot, StringViewRoot } from "@/ui/app/string-view-root.ts";
import { StringViewRunningAgents } from "@/ui/chrome/string-view-running-agents.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";
import { StringViewOverlayHost } from "@/ui/panels/string-view-overlay-host.ts";
import { StringViewDetailedTranscript } from "@/ui/transcript/string-view-detailed-transcript.ts";
import { StringViewTranscript } from "@/ui/transcript/string-view-transcript.ts";

const WIDTH = 100;

function indexContaining(rows: readonly string[], needle: string): number {
  return rows.findIndex((row) => row.includes(needle));
}

const initialAppState = appStore.getState();
let workspace: string | undefined;

afterEach(() => {
  dispatch({ type: "view/setViewingAgent", id: null });
  appStore.setState(() => initialAppState);
  clearBackgroundTasks();
  resetEmitThrottleForTests();
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
  workspace = undefined;
});

describe("string-view footer order", () => {
  test("running agents close the footer, below the status rows", () => {
    startTask({
      parentToolCallId: "call-1",
      agentName: "reviewer",
      agentId: "general-purpose",
      description: "audit the queue",
      isBackgrounded: true,
    });

    const rows = buildStringViewRoot()
      .render(WIDTH)
      .map((row) => stripAnsi(row).trimEnd());
    const promptRule = indexContaining(rows, "─");
    const status = indexContaining(rows, "available");
    const agents = indexContaining(rows, "audit the queue");

    expect(promptRule).toBeGreaterThanOrEqual(0);
    expect(status).toBeGreaterThan(promptRule);
    expect(agents).toBeGreaterThan(status);
  });
});

describe("string-view document swap", () => {
  test("opening an agent replaces the conversation and Escape brings it back", async () => {
    workspace = mkdtempSync(join(tmpdir(), "otherside-doc-swap-"));
    const task = startTask({
      parentToolCallId: "call-1",
      agentName: "reviewer",
      agentId: "general-purpose",
      description: "audit the queue",
      cwd: workspace,
      sessionId: "parent-session",
      isBackgrounded: true,
    });
    setForkId(task.id, "fork-1");
    const path = agentTranscriptPathForCwd(workspace, "parent-session", "fork-1");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "assistant_message",
        ts: new Date(0).toISOString(),
        content: "only the agent said this",
      })}\n`,
    );

    const transcript = new StringViewTranscript();
    const prompt = new StringViewPrompt();
    const promptScreen = new StringContainer();
    promptScreen.addChild(prompt);
    promptScreen.addChild(new StringViewRunningAgents());
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
    transcriptActions.replace([
      { id: "u1", kind: "user", text: "only the main conversation said this" },
    ]);

    dispatch({ type: "view/setViewingAgent", id: task.id });
    for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 5));

    // The surface swap hands the agent's settled history to native scrollback.
    const swap = root.takeScrollbackBatch(WIDTH);
    expect(swap.mode).toBe("switch");
    const swapRows = (swap.mode === "switch" ? swap.rows : []).map(stripAnsi).join("\n");
    expect(swapRows).toContain("only the agent said this");
    const viewing = root.render(WIDTH).map(stripAnsi).join("\n");
    expect(viewing).not.toContain("only the main conversation said this");
    // The footer stays: the agent view is a conversation surface, not a reader.
    expect(viewing).toContain("reviewer");

    expect(root.handleKey({ name: "escape" } as KeyEventData)).toBe(true);
    const back = root.takeScrollbackBatch(WIDTH);
    expect(back.mode).toBe("switch");
    const backRows = (back.mode === "switch" ? back.rows : []).map(stripAnsi).join("\n");
    expect(backRows).toContain("only the main conversation said this");
    const returned = root.render(WIDTH).map(stripAnsi).join("\n");
    expect(returned).not.toContain("only the agent said this");

    root.unmount();
  });
});
