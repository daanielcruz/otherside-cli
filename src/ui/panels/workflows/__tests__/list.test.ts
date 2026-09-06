import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { formatHint, hintFor } from "@/ui/chrome/panel-hints.ts";
import type { WorkflowListItem } from "@/ui/panels/workflows/items.ts";
import { listFooterHints, renderWorkflowList } from "@/ui/panels/workflows/list.ts";
import { Color } from "@/ui/theme/theme.ts";

const WIDTH = 100;
const ROWS = 40;

// Color is the assertion here, so the rows have to carry it.
const originalColorLevel = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = originalColorLevel;
});

function item(overrides: Partial<WorkflowListItem> = {}): WorkflowListItem {
  return {
    id: "task-1",
    runId: "run-1",
    name: "Nightly audit",
    description: "",
    status: "completed",
    agentCount: 2,
    totalTokens: 10,
    durationMs: 1000,
    startTime: 0,
    script: "export const meta = {}\n",
    phases: [],
    workflowProgress: [],
    live: false,
    ...overrides,
  };
}

function rows(items: WorkflowListItem[], cursor = 0): string[] {
  return renderWorkflowList({ items, cursor, loading: false, terminalRows: ROWS, width: WIDTH });
}

function rowFor(items: WorkflowListItem[], name: string, cursor = 0): string {
  return rows(items, cursor).find((row) => stripAnsi(row).includes(name)) ?? "";
}

describe("a run's status glyph", () => {
  it("carries the failure color while the name does not", () => {
    const row = rowFor([item({ name: "Broken run", status: "failed" })], "Broken run");

    expect(row).toContain(renderTextWithStyles("✘ ", { color: Color.error }));
    expect(stripAnsi(row)).toContain("✘ Broken run");
  });

  it("greens a completed run and warns on a killed one", () => {
    const list = [
      item({ id: "a", name: "Finished run", status: "completed" }),
      item({ id: "b", name: "Stopped run", status: "killed" }),
    ];

    expect(rowFor(list, "Finished run")).toContain(
      renderTextWithStyles("✔ ", { color: Color.success }),
    );
    expect(rowFor(list, "Stopped run")).toContain(
      renderTextWithStyles("✘ ", { color: Color.warning }),
    );
  });

  it("leaves a running run's spinner uncolored", () => {
    const row = rowFor([item({ name: "Live run", status: "running" })], "Live run");
    const glyph = stripAnsi(row).trim().split(" ")[1] ?? "";

    for (const color of [Color.error, Color.success, Color.warning]) {
      expect(row).not.toContain(renderTextWithStyles(`${glyph} `, { color }));
    }
  });

  it("keeps the selected row's own emphasis on the name", () => {
    const list = [item({ id: "a", name: "First run" }), item({ id: "b", name: "Second run" })];

    expect(rowFor(list, "First run", 0)).toContain(
      renderTextWithStyles("First run", { color: Color.panelAccent, bold: true }),
    );
    expect(rowFor(list, "First run", 1)).toContain(
      renderTextWithStyles("First run", { color: Color.text, bold: false }),
    );
  });
});

describe("the list's footer hints", () => {
  it("phrases every hint from the shared vocabulary", () => {
    const hints = listFooterHints([item()], item());

    expect(hints).toEqual(
      [hintFor("arrowsSelect"), hintFor("enterView"), hintFor("sSave"), hintFor("close")].map(
        (hint) => [hint.keys.join("/"), hint.label] as [string, string],
      ),
    );
    expect(formatHint(hintFor("arrowsSelect"))).toBe("↑/↓ to select");
  });

  it("offers pause on a running run and kill on a paused one", () => {
    const running = item({ status: "running" });
    const paused = item({ status: "paused" });

    expect(listFooterHints([running], running)).toContainEqual(["x", "to pause"]);
    expect(listFooterHints([paused], paused)).toContainEqual(["x", "to kill"]);
  });

  it("offers only close when there is nothing to act on", () => {
    expect(listFooterHints([], undefined)).toEqual([["Esc", "to close"]]);
  });

  it("drops the save hint for a run that carries no script", () => {
    const scriptless = item({ script: "" });

    expect(listFooterHints([scriptless], scriptless)).not.toContainEqual(["s", "to save"]);
  });
});
