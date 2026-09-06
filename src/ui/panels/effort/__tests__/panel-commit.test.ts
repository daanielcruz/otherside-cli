import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEffortFeedback } from "@/commands/handlers/effort.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { dispatch } from "@/store/app-store/index.ts";
import { recordPanelCommitRef } from "@/store/turn-run/index.ts";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { createEffortPanel } from "@/ui/panels/effort/string-view.ts";
import { createUltracodeEffortPanel } from "@/ui/panels/ultracode-effort/string-view.ts";

registerAllProviders();

const ctx: StringViewContext = {
  requestRender: () => {},
  pushFocus: () => {},
  popFocus: () => {},
};

let base: string;
let savedConfigDir: string | undefined;
let commits: { command: string; feedback: string }[];
const originalCommit = recordPanelCommitRef.current;

function seedBroker(effort: string, ultracode: boolean): void {
  dispatch({
    type: "engine/setSlice",
    key: "broker",
    value: {
      provider: "codex",
      model: "gpt-5.6-sol",
      effort,
      fastMode: false,
      permissionMode: "default",
      orchestrationMode: "disabled",
      ultracode,
    },
  });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "effort-commit-"));
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
  commits = [];
  recordPanelCommitRef.current = (command, feedback) => {
    commits.push({ command, feedback });
  };
});

afterEach(() => {
  recordPanelCommitRef.current = originalCommit;
  if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  rmSync(base, { recursive: true, force: true });
});

describe("effort panel commit feedback", () => {
  it("records a feedback line when the effort level changes", () => {
    seedBroker("high", false);
    const panel = createEffortPanel(() => {});
    panel.mount?.(ctx);
    panel.handleKey?.({ name: "left" } as never);
    panel.handleKey?.({ name: "return" } as never);
    panel.unmount?.();

    expect(commits).toEqual([{ command: "effort", feedback: setEffortFeedback("medium") }]);
  });

  it("stays silent when the selection matches the current level", () => {
    seedBroker("high", false);
    const panel = createEffortPanel(() => {});
    panel.mount?.(ctx);
    panel.handleKey?.({ name: "return" } as never);
    panel.unmount?.();

    expect(commits).toEqual([]);
  });
});

describe("ultracode effort panel commit feedback", () => {
  it("records the chosen ultracode effort", () => {
    seedBroker("high", false);
    const panel = createUltracodeEffortPanel(() => {});
    panel.mount?.(ctx);
    panel.handleKey?.({ name: "return" } as never);
    panel.unmount?.();

    expect(commits).toEqual([{ command: "effort", feedback: "ultracode with high effort" }]);
  });
});
