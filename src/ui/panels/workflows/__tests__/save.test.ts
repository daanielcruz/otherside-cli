import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import type { WorkflowListItem } from "@/ui/panels/workflows/items.ts";
import {
  renderSaved,
  renderSaveError,
  renderSaveScopePicker,
  saveWorkflowScript,
  workflowSavePath,
} from "@/ui/panels/workflows/save.ts";

const WIDTH = 100;
const ROWS = 40;

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "workflow-save-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
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

describe("saving a workflow script", () => {
  it("writes the script under the project and reports where it landed", async () => {
    const outcome = await saveWorkflowScript(item(), "Nightly audit", 0, projectRoot);

    expect(outcome.kind).toBe("saved");
    if (outcome.kind !== "saved") return;
    expect(outcome.path).toBe(workflowSavePath("Nightly audit", 0, projectRoot));
    expect(readFileSync(outcome.path, "utf8")).toBe("export const meta = {}\n");
  });

  it("refuses to replace a script already there and names the file", async () => {
    const path = workflowSavePath("Nightly audit", 0, projectRoot);
    mkdirSync(join(projectRoot, ".otherside", "workflows"), { recursive: true });
    writeFileSync(path, "the user's own edit", "utf8");

    const outcome = await saveWorkflowScript(item(), "Nightly audit", 0, projectRoot);

    expect(outcome).toEqual({ kind: "exists", path });
    // The existing file is what matters: a silent overwrite would lose their work.
    expect(readFileSync(path, "utf8")).toBe("the user's own edit");
  });

  it("keeps the library and the script readable by their owner alone", async () => {
    const outcome = await saveWorkflowScript(item(), "Nightly audit", 0, projectRoot);

    expect(outcome.kind).toBe("saved");
    if (outcome.kind !== "saved") return;
    const permissions = (path: string): number => statSync(path).mode & 0o777;
    expect(permissions(outcome.path)).toBe(0o600);
    expect(permissions(join(projectRoot, ".otherside", "workflows"))).toBe(0o700);
  });
});

describe("the save flow's screens", () => {
  it("offers the project and user scopes with the selected one marked", () => {
    const rows = renderSaveScopePicker({
      item: item(),
      name: "Nightly audit",
      field: "scope" as const,
      scope: 0,
      projectRoot,
      terminalRows: ROWS,
      width: WIDTH,
    }).map(stripAnsi);
    const text = rows.join("\n");

    expect(text).toContain("Save workflow");
    expect(text).toContain("Name  Nightly audit");
    expect(text).toContain("Project (");
    expect(text).toContain("User (");
    expect(rows.some((row) => row.includes("❯") && row.includes("Project ("))).toBe(true);
  });

  it("puts the cursor on the name row first and shows the file it would write", () => {
    const rows = renderSaveScopePicker({
      item: item(),
      name: "Nightly audit",
      field: "name" as const,
      scope: 0,
      projectRoot,
      terminalRows: ROWS,
      width: WIDTH,
    }).map(stripAnsi);
    const text = rows.join("\n");

    expect(rows.some((row) => row.includes("❯") && row.includes("Name"))).toBe(true);
    // The derived filename is visible while typing, so a collision is foreseeable
    // rather than a surprise at the moment of saving.
    expect(text).toContain("nightly-audit.js");
    expect(text).toContain("Type to rename");
  });

  it("derives a different file once the name is edited", () => {
    const text = renderSaveScopePicker({
      item: item(),
      name: "Nightly audit v2",
      field: "name" as const,
      scope: 0,
      projectRoot,
      terminalRows: ROWS,
      width: WIDTH,
    })
      .map(stripAnsi)
      .join("\n");

    expect(text).toContain("nightly-audit-v2.js");
  });

  it("marks the user scope once the selection moves to it", () => {
    const rows = renderSaveScopePicker({
      item: item(),
      name: "Nightly audit",
      field: "scope" as const,
      scope: 1,
      projectRoot,
      terminalRows: ROWS,
      width: WIDTH,
    }).map(stripAnsi);

    expect(rows.some((row) => row.includes("❯") && row.includes("User ("))).toBe(true);
  });

  it("confirms the path it saved to", () => {
    const text = renderSaved("/tmp/x/nightly-audit.js", ROWS, WIDTH).map(stripAnsi).join("\n");

    expect(text).toContain("Saved workflow to /tmp/x/nightly-audit.js");
    expect(text).toContain("any key");
  });

  it("explains a collision and says what to do about it", () => {
    const text = renderSaveError("/tmp/x/nightly-audit.js", ROWS, WIDTH).map(stripAnsi).join("\n");

    expect(text).toContain("A workflow already exists at /tmp/x/nightly-audit.js");
    expect(text).toContain("Pick a different scope");
  });
});
