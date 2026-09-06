import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import chalk from "chalk";
import {
  clear as clearBackgroundTasks,
  setRoute,
  startTask,
} from "@/engine/background/tasks/background.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { dispatch } from "@/store/app-store/index.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { openAgentAddressee } from "@/ui/input/agent-addressee.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";

const NOOP_CONTEXT = { requestRender() {}, pushFocus() {}, popFocus() {} };
const WIDTH = 100;

function openAgent(overrides: { agentName?: string; agentId?: string } = {}): string {
  const task = startTask({
    parentToolCallId: "call_addressee",
    agentName: overrides.agentName ?? "review-the-auth",
    ...(overrides.agentId === undefined ? {} : { agentId: overrides.agentId }),
    isBackgrounded: true,
  });
  setRoute(task.id, { provider: "anthropic", model: "claude-opus-5" }, "xhigh");
  dispatch({ type: "view/setViewingAgent", id: task.id });
  return task.id;
}

const originalColorLevel = chalk.level;

beforeAll(() => {
  // The accent lives in the colour bytes, so the rules need a truecolor terminal.
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

beforeEach(() => {
  registerAllProviders();
  clearBackgroundTasks();
  dispatch({ type: "view/setViewingAgent", id: null });
});

afterEach(() => {
  dispatch({ type: "view/setViewingAgent", id: null });
  clearBackgroundTasks();
});

describe("openAgentAddressee", () => {
  it("names the running route, not what the agent was asked to do", () => {
    openAgent({ agentName: "review-the-auth" });

    const addressee = openAgentAddressee();

    expect(addressee?.identity).toBe("review-the-auth - Opus 5 xHigh");
    expect(addressee?.placeholder).toBe("Message @review-the-auth…");
  });

  it("leads with the agent type when the task carries one", () => {
    openAgent({ agentName: "sweep-the-logs", agentId: "general-purpose" });

    expect(openAgentAddressee()?.identity).toContain("- Opus 5 xHigh");
    expect(openAgentAddressee()?.identity).not.toStartWith("sweep-the-logs");
  });

  it("elides a long name in the placeholder so it stays one short line", () => {
    openAgent({ agentName: "an-extremely-long-agent-name-that-runs-on" });

    expect(openAgentAddressee()?.placeholder).toBe("Message @an-extremely-long...…");
  });

  it("answers null while the main conversation is the one on screen", () => {
    expect(openAgentAddressee()).toBeNull();
  });
});

describe("the promptbar while an agent document is open", () => {
  let prompt: StringViewPrompt;

  beforeEach(() => {
    prompt = new StringViewPrompt();
    prompt.mount(NOOP_CONTEXT);
  });

  afterEach(() => {
    prompt.unmount();
  });

  it("carries the agent identity on the top rule", () => {
    openAgent();
    const [topRule] = prompt.render(WIDTH).map(stripAnsi);

    expect(topRule).toContain("review-the-auth - Opus 5 xHigh");
  });

  it("stands an empty prompt in with who the message reaches", () => {
    openAgent();
    const rows = prompt.render(WIDTH).map(stripAnsi);

    expect(rows[1]).toContain("Message @review-the-auth…");
  });

  // The caret rests on the first letter, and only its inversion belongs to the caret.
  // Colouring that letter apart would split the phrase in two whenever the caret went
  // unlit — a window losing focus, or the reader stepping into a panel.
  it("keeps the stand-in one colour under the caret", () => {
    openAgent();
    const [, standIn = ""] = prompt.render(WIDTH);
    const letters = [...standIn.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m\x1b\[2m(?:\x1b\[7m)?(\w)/g)];

    expect(letters.length).toBeGreaterThan(1);
    expect(new Set(letters.map((match) => match[1])).size).toBe(1);
  });

  it("gives the rules the agent accent and takes it back on close", () => {
    const plain = prompt.render(WIDTH);
    openAgent();
    const addressed = prompt.render(WIDTH);
    dispatch({ type: "view/setViewingAgent", id: null });
    const closed = prompt.render(WIDTH);

    // The bottom rule carries nothing but its colour, so it isolates the accent.
    expect(addressed.at(-1)).not.toBe(plain.at(-1));
    expect(closed.at(-1)).toBe(plain.at(-1));
  });

  it("returns the top rule to the effort badge once the document closes", () => {
    openAgent();
    expect(stripAnsi(prompt.render(WIDTH)[0] ?? "")).toContain("Opus 5 xHigh");

    dispatch({ type: "view/setViewingAgent", id: null });
    const [topRule] = prompt.render(WIDTH).map(stripAnsi);

    expect(topRule).not.toContain("review-the-auth");
    expect(topRule).not.toContain("Message @");
  });

  it("drops the placeholder as soon as the prompt holds text", () => {
    openAgent();
    prompt.handleKey({ name: undefined, sequence: "h" } as never);
    const rows = prompt.render(WIDTH).map(stripAnsi);

    expect(rows[1]).not.toContain("Message @");
    expect(rows[1]).toContain("h");
  });
});
