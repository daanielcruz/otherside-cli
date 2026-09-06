import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { ask, clear as clearPermissions } from "@/kernel/channels/permission.ts";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { StringViewPermissionPrompt } from "@/ui/panels/permission/string-view.ts";
import {
  toolPresentation,
  WORKFLOW_USAGE_WARNING,
} from "@/ui/panels/permission/tool-presentation.ts";
import { Color } from "@/ui/theme/theme.ts";

const WIDTH = 90;

const ctx: StringViewContext = {
  requestRender: () => {},
  pushFocus: () => {},
  popFocus: () => {},
};

const originalColorLevel = chalk.level;

beforeAll(() => {
  // Color is off by default here, which would let every assertion below compare
  // plain text to plain text and pass while measuring nothing.
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

afterEach(() => {
  clearPermissions();
});

function scriptWith(phases: { title: string; detail?: string }[]): string {
  const entries = phases
    .map((phase) =>
      phase.detail
        ? `{ title: '${phase.title}', detail: '${phase.detail}' }`
        : `{ title: '${phase.title}' }`,
    )
    .join(", ");
  return [
    "export const meta = {",
    "  name: 'nightly-audit',",
    "  description: 'sweeps the tree for regressions',",
    `  phases: [${entries}],`,
    "}",
    "phase('Scan')",
  ].join("\n");
}

function present(input: Record<string, unknown>) {
  return toolPresentation(
    {
      id: "pending-1",
      toolName: "Workflow",
      argsPreview: "nightly-audit",
      rule: null,
      input,
      resolve: () => {},
    },
    WIDTH,
  );
}

function bodyText(input: Record<string, unknown>): string {
  return present(input).body.map(stripAnsi).join("\n");
}

describe("the workflow permission body", () => {
  it("always states what the run costs", () => {
    const { warning, title } = present({ script: scriptWith([{ title: "Scan" }]) });

    expect(title).toBe("Dynamic workflow");
    expect(warning).toBe(WORKFLOW_USAGE_WARNING);
    expect(warning).toContain("/workflows");
    expect(warning).toContain("/config");
  });

  it("keeps the warning even when the script will not parse", () => {
    const { warning, body } = present({ script: "this is not a workflow script" });

    expect(warning).toBe(WORKFLOW_USAGE_WARNING);
    expect(body.length).toBeGreaterThan(0);
  });

  it("numbers the phases the run will spawn", () => {
    const body = bodyText({
      script: scriptWith([
        { title: "Scan", detail: "collect candidates" },
        { title: "Verify", detail: "adversarial check" },
      ]),
    });

    expect(body).toContain("nightly-audit");
    expect(body).toContain("sweeps the tree for regressions");
    expect(body).toContain("The run will spawn subagents across these phases:");
    expect(body).toContain("1. Scan — collect candidates");
    expect(body).toContain("2. Verify — adversarial check");
  });

  it("reports the phases it withholds instead of dropping them silently", () => {
    const phases = Array.from({ length: 9 }, (_, index) => ({ title: `Phase${index + 1}` }));
    const body = bodyText({ script: scriptWith(phases) });

    expect(body).toContain("6. Phase6");
    expect(body).not.toContain("7. Phase7");
    expect(body).toContain("… 3 more");
  });

  it("shows args and bounds them", () => {
    const short = bodyText({ script: scriptWith([{ title: "Scan" }]), args: ["a.ts", "b.ts"] });
    expect(short).toContain('args: ["a.ts","b.ts"]');

    const long = bodyText({
      script: scriptWith([{ title: "Scan" }]),
      args: "x".repeat(400),
    });
    // The clipped value wraps across rows, so the block is measured whole.
    const argsBlock = long.slice(long.indexOf("args: ")).replace(/\n/g, "");
    expect(argsBlock.length).toBeLessThan(400);
    expect(argsBlock.endsWith("…")).toBe(true);
  });

  it("names a workflow invoked without an inline script", () => {
    const body = bodyText({ name: "deep-research" });
    expect(body).toContain("deep-research");
  });
});

describe("the workflow permission panel", () => {
  function workflowRequest(rule: string | null, input: Record<string, unknown>): void {
    void ask({ toolName: "Workflow", argsPreview: "nightly-audit", rule, input });
  }

  function mounted(): StringViewPermissionPrompt {
    const prompt = new StringViewPermissionPrompt();
    prompt.mount(ctx);
    return prompt;
  }

  it("carries the warning to the screen in warning color", () => {
    workflowRequest(null, { script: scriptWith([{ title: "Scan", detail: "collect" }]) });
    const prompt = mounted();
    const rows = prompt.render(WIDTH);
    const plain = rows.map(stripAnsi).join("\n");

    expect(plain).toContain("Dynamic workflow");
    expect(plain).toContain("1. Scan — collect");
    expect(plain).toContain("can spend tokens fast");
    expect(plain).toContain("Do you want to run it?");

    // The warning wraps, so the colour is asserted on the row that carries the
    // text rather than on a substring the wrap may have split.
    const warningOpener = renderTextWithStyles("|", { color: Color.warning }).split("|")[0] ?? "";
    expect(warningOpener.length).toBeGreaterThan(0);
    const warned = rows.some(
      (row) => stripAnsi(row).includes("can spend tokens fast") && row.includes(warningOpener),
    );
    expect(warned).toBe(true);
    prompt.unmount();
  });

  it("scopes always-allow to the workflow's own name", () => {
    workflowRequest("Workflow(nightly-audit)", { name: "nightly-audit" });
    const prompt = mounted();
    const plain = prompt.render(WIDTH).map(stripAnsi).join("\n");

    expect(plain).toContain("don't ask again for Workflow(nightly-audit)");
    prompt.unmount();
  });

  it("offers no always-allow for a run that has no name to remember", () => {
    workflowRequest(null, { script: scriptWith([{ title: "Scan" }]) });
    const prompt = mounted();
    const plain = prompt.render(WIDTH).map(stripAnsi).join("\n");

    expect(plain).not.toContain("don't ask again");
    prompt.unmount();
  });
});
