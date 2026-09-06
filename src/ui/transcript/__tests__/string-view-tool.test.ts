import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import { INTERRUPTED_FEEDBACK } from "@/engine/queue/runtime/interruption-text.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import { register, unregister } from "@/engine/tools/registry.ts";
import { wireToolName } from "@/kernel/mcp/protocol/wire-name.ts";
import { makeMcpRenderHooks } from "@/kernel/mcp/runtime/manager.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { Color, Glyph, GUTTER_CONT, GUTTER_HEAD } from "@/ui/theme/theme.ts";
import { formatToolLines, type ToolEntryData } from "@/ui/transcript/string-view-tool.ts";

const originalColorLevel = chalk.level;
const FG_24BIT = /\x1b\[38;2;\d+;\d+;\d+m/;

beforeAll(() => {
  chalk.level = 3;
  registerAllBuiltins();
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

function entry(status: ToolEntryData["status"]): ToolEntryData {
  return {
    name: "Bash",
    args: { command: "printf hello" },
    status,
    payload: null,
  };
}

function plain(lines: string[]): string[] {
  return lines.map((line) => stripAnsi(line));
}

function workflowTask(overrides: Partial<WorkflowTaskLifecycle> = {}): WorkflowTaskLifecycle {
  return {
    id: "wf_1",
    type: "local_workflow",
    status: "running",
    parentToolCallId: "call_1",
    workflowRunId: "run_1",
    cwd: "/tmp",
    sessionId: "sess",
    workflowName: "demo",
    description: "demo workflow",
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    startedAt: 1_000,
    abortController: new AbortController(),
    ...overrides,
  };
}

describe("formatToolLines", () => {
  it("renders the settled status glyph with a bold tool head", () => {
    const [head] = formatToolLines(entry("ok"), 80);

    expect(stripAnsi(head ?? "")).toBe(`${Glyph.bullet} Bash(printf hello)`);
    expect(head).toContain("\x1b[1m");
    expect(head).toMatch(FG_24BIT);
  });

  it("wraps text payloads under the tool gutter", () => {
    const lines = formatToolLines(
      {
        name: "Read",
        args: { file_path: "/workspace/file.ts" },
        status: "ok",
        payload: {
          kind: "preview",
          text: "alpha beta gamma delta epsilon zeta eta theta",
        },
      },
      22,
    );
    const payloadIndex = lines.findIndex((row) => stripAnsi(row).startsWith(GUTTER_HEAD));
    const body = lines.slice(payloadIndex);

    expect(payloadIndex).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThan(1);
    expect(stripAnsi(body[0] ?? "").startsWith(GUTTER_HEAD)).toBe(true);
    for (const row of body.slice(1)) {
      expect(stripAnsi(row).startsWith(GUTTER_CONT)).toBe(true);
    }
    expect(body.every((row) => stringWidth(row) <= 22)).toBe(true);
  });

  it("uses distinct 24-bit glyph colors for running, ok, and error", () => {
    const colors = (["running", "ok", "error"] as const).map((status) => {
      const [head] = formatToolLines(entry(status), 80);
      return head?.match(FG_24BIT)?.[0];
    });

    expect(colors.every((color) => color !== undefined)).toBe(true);
    expect(new Set(colors).size).toBe(3);
  });

  it("is deterministic for identical data and width", () => {
    const data: ToolEntryData = {
      name: "Bash",
      args: { command: "printf hello" },
      status: "error",
      payload: { kind: "bash", stdout: "first\nsecond", stderr: "failure", exitCode: 1 },
    };

    expect(formatToolLines(data, 30)).toEqual(formatToolLines(data, 30));
  });
});

describe("hook-driven tool head labels", () => {
  it("labels Edit as Update and Create from render hooks", () => {
    const update = plain(
      formatToolLines(
        {
          name: "Edit",
          args: {
            file_path: "/workspace/file.ts",
            old_string: "old",
            new_string: "new",
          },
          status: "ok",
          payload: null,
        },
        80,
      ),
    );
    const create = plain(
      formatToolLines(
        {
          name: "Edit",
          args: {
            file_path: "/workspace/new.ts",
            old_string: "",
            new_string: "body",
          },
          status: "ok",
          payload: null,
        },
        80,
      ),
    );

    expect(update[0]).toContain(`${Glyph.bullet} Update(/workspace/file.ts)`);
    expect(create[0]).toContain(`${Glyph.bullet} Create(/workspace/new.ts)`);
    expect(update.join("\n")).not.toContain("Edit(");
    expect(create.join("\n")).not.toContain("Edit(");
  });

  it("keeps Workflow script args from hooks inside the head parens", () => {
    const script = 'agent("review", "scan the tree")';
    const lines = plain(
      formatToolLines(
        {
          name: "Workflow",
          args: { script },
          status: "running",
          payload: null,
        },
        120,
      ),
    );

    expect(lines[0]).toContain(`${Glyph.bullet} Workflow(`);
    expect(lines.join("\n")).toContain("agent(");
  });
});

describe("interrupt and workflow payloads", () => {
  it("renders interrupt feedback under the tool gutter", () => {
    const lines = plain(
      formatToolLines(
        {
          name: "Bash",
          args: { command: "sleep 30" },
          status: "error",
          payload: { kind: "interrupt" },
        },
        80,
      ),
    );

    expect(lines.some((line) => line.includes(INTERRUPTED_FEEDBACK))).toBe(true);
    expect(lines[1]?.startsWith(GUTTER_HEAD)).toBe(true);
  });

  it("renders running and terminal workflow status payloads", () => {
    const running = plain(
      formatToolLines(
        {
          name: "Workflow",
          args: { script: "agent('a','b')" },
          status: "ok",
          payload: { kind: "workflow", task: workflowTask() },
        },
        100,
      ),
    );
    const done = plain(
      formatToolLines(
        {
          name: "Workflow",
          args: { script: "agent('a','b')" },
          status: "ok",
          payload: {
            kind: "workflow",
            task: workflowTask({
              status: "completed",
              endedAt: 5_000,
              agentCount: 2,
              workflowProgress: [
                {
                  type: "workflow_agent",
                  index: 0,
                  label: "one",
                  state: "done",
                  startedAt: 1_000,
                  lastProgressAt: 2_000,
                  tokens: 1200,
                },
              ],
            }),
          },
        },
        100,
      ),
    );

    expect(running.some((line) => line.includes("/workflows"))).toBe(true);
    expect(running.some((line) => line.includes("Running in background"))).toBe(true);
    expect(done.some((line) => line.includes("Done"))).toBe(true);
    expect(done.some((line) => line.includes("agent"))).toBe(true);
  });
});

describe("Bash payload fidelity", () => {
  it("keeps stdout and stderr as separate gutter rows", () => {
    const lines = plain(
      formatToolLines(
        {
          name: "Bash",
          args: { command: "printf hello >&2; printf world" },
          status: "ok",
          payload: {
            kind: "bash",
            stdout: "world",
            stderr: "hello",
            exitCode: 0,
          },
        },
        80,
      ),
    );
    const body = lines.slice(1);

    expect(body).toHaveLength(2);
    expect(body[0]).toBe(`${GUTTER_HEAD}world`);
    expect(body[1]).toBe(`${GUTTER_CONT}hello`);
  });

  it("collapses a validation failure until the detailed view restores its issues", () => {
    const data: ToolEntryData = {
      name: "Bash",
      args: { command: "ls" },
      status: "error",
      payload: {
        kind: "preview",
        text: "Error: InputValidationError: Bash failed due to the following issue(s):\ncommand is required\ntimeout must be a number",
      },
    };

    const compact = plain(formatToolLines(data, 80));
    expect(compact.slice(1)).toEqual([`${GUTTER_HEAD}Invalid tool parameters`]);

    const detailed = plain(formatToolLines(data, 80, "detailed")).join("\n");
    expect(detailed).toContain("InputValidationError");
    expect(detailed).toContain("timeout must be a number");
  });

  it("opens a block for the shell cwd reset instead of continuing the output", () => {
    const lines = plain(
      formatToolLines(
        {
          name: "Bash",
          args: { command: "cd /elsewhere && ls" },
          status: "ok",
          payload: {
            kind: "bash",
            stdout: "one\ntwo",
            stderr: "Shell cwd was reset to /workspace",
            exitCode: 0,
          },
        },
        80,
      ),
    );

    expect(lines.slice(1)).toEqual([
      `${GUTTER_HEAD}one`,
      `${GUTTER_CONT}two`,
      `${GUTTER_HEAD}Shell cwd was reset to /workspace`,
    ]);
  });

  it("surfaces empty-stream exit codes and no-output labels", () => {
    const noOutput = plain(
      formatToolLines(
        {
          name: "Bash",
          args: { command: "true" },
          status: "ok",
          payload: {
            kind: "bash",
            stdout: "(No output)",
            stderr: "",
            exitCode: 0,
          },
        },
        80,
      ),
    );
    const exitOnly = plain(
      formatToolLines(
        {
          name: "Bash",
          args: { command: "false" },
          status: "error",
          payload: {
            kind: "bash",
            stdout: "",
            stderr: "",
            exitCode: 1,
          },
        },
        80,
      ),
    );

    expect(noOutput.some((line) => line.includes("(No output)"))).toBe(true);
    expect(exitOnly.some((line) => line.includes("Error: Exit code 1"))).toBe(true);
  });

  it("shows Running… and the background hint while Bash is live", () => {
    const lines = plain(
      formatToolLines(
        {
          name: "Bash",
          args: { command: "sleep 5" },
          status: "running",
          elapsedMs: 3_500,
          payload: null,
        },
        80,
      ),
    );

    expect(lines.some((line) => line.includes("Running… (3s)"))).toBe(true);
    expect(lines.some((line) => line.includes("ctrl+b"))).toBe(true);
  });

  it("indents multiline Bash commands beneath the tool name when expanded", () => {
    const lines = plain(
      formatToolLines(
        {
          name: "Bash",
          args: { command: "git commit -m \"$(cat <<'EOF'\nsubject\n\nbody\nEOF\n)\"" },
          status: "ok",
          payload: { kind: "bash", stdout: "done", stderr: "", exitCode: 0 },
        },
        80,
        "verbose",
      ),
    );

    expect(lines[0]).toBe(`${Glyph.bullet} Bash(git commit -m "$(cat <<'EOF'`);
    expect(lines[1]).toBe("      subject");
    expect(lines[2]).toBe("      ");
    expect(lines[3]).toBe("      body");
    expect(lines[5]).toBe('      )")');
  });

  it("clips the compact Bash header to two lines with an ellipsis", () => {
    const lines = plain(
      formatToolLines(
        {
          name: "Bash",
          args: { command: "git commit -m \"$(cat <<'EOF'\nsubject\n\nbody\nEOF\n)\"" },
          status: "ok",
          payload: { kind: "bash", stdout: "done", stderr: "", exitCode: 0 },
        },
        80,
      ),
    );

    expect(lines[0]).toBe(`${Glyph.bullet} Bash(git commit -m "$(cat <<'EOF'`);
    expect(lines[1]).toBe("      subject…)");
    expect(lines.filter((line) => line.startsWith("      ")).length).toBe(1);
  });

  it("clips a long single-line compact Bash header at 160 characters", () => {
    const command = `echo ${"x".repeat(200)}`;
    const lines = plain(
      formatToolLines({ name: "Bash", args: { command }, status: "ok", payload: null }, 400),
    );
    const verbose = plain(
      formatToolLines(
        { name: "Bash", args: { command }, status: "ok", payload: null },
        400,
        "verbose",
      ),
    );

    expect(lines[0]).toBe(`${Glyph.bullet} Bash(${command.slice(0, 160)}…)`);
    expect(verbose[0]).toBe(`${Glyph.bullet} Bash(${command})`);
  });

  it("keeps a short compact Bash header whole", () => {
    const lines = plain(
      formatToolLines(
        { name: "Bash", args: { command: "printf hello" }, status: "ok", payload: null },
        80,
      ),
    );
    expect(lines[0]).toBe(`${Glyph.bullet} Bash(printf hello)`);
  });

  it("keeps a long single-token command inside the terminal width", () => {
    const command =
      "echo alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliett-kilo-lima-mike-november";

    // Neighbouring widths, so this cannot pass by landing on one lucky column count.
    for (const width of [86, 87, 88, 89]) {
      const lines = plain(
        formatToolLines({ name: "Bash", args: { command }, status: "ok", payload: null }, width),
      );

      // A row wider than the terminal is folded by the terminal itself, which drops
      // the overflow onto a row carrying none of the continuation indent.
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width);

      expect(lines[0]).toStartWith(`${Glyph.bullet} Bash(`);
      expect(lines.at(-1)).toEndWith(")");
      for (const line of lines.slice(1)) expect(line).toStartWith("      ");

      // Peeling the head off the first row and the indent off the rest must give the
      // command back whole: no column may be dropped or duplicated by the wrap.
      const rejoined = lines
        .map((line, index) =>
          index === 0 ? line.slice(`${Glyph.bullet} Bash(`.length) : line.slice(6),
        )
        .join("");
      expect(rejoined).toBe(`${command})`);
    }
  });
});

describe("nested subagent rows", () => {
  it("keeps the head bullet/loader and gutter-prefixed nested tool lines", () => {
    const lines = plain(
      formatToolLines(
        {
          name: "Agent",
          args: { subagent_type: "general-purpose", description: "scan files" },
          status: "running",
          payload: null,
          nested: [
            {
              toolName: "Bash",
              args: { command: "echo one" },
              running: true,
            },
            {
              toolName: "Edit",
              args: {
                file_path: "/workspace/a.ts",
                old_string: "a",
                new_string: "b",
              },
              running: false,
            },
          ],
        },
        80,
      ),
    );

    expect(lines[0]?.startsWith(`${Glyph.bullet} `)).toBe(true);
    expect(lines[0]).toContain("scan files");
    expect(
      lines.some((line) => line.startsWith(GUTTER_HEAD) && line.includes("Bash(echo one)")),
    ).toBe(true);
    expect(
      lines.some(
        (line) => line.startsWith(GUTTER_CONT) && line.includes("Update(/workspace/a.ts)"),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.includes("ctrl+b"))).toBe(true);
  });

  it("prefers argumentLabel for task-projected nested rows and hides silent tools", () => {
    const lines = plain(
      formatToolLines(
        {
          name: "Agent",
          args: { description: "work" },
          status: "running",
          payload: null,
          nested: [
            {
              toolName: "Bash",
              args: null,
              running: true,
              argumentLabel: "ls -la",
            },
            {
              toolName: "TaskUpdate",
              args: { task_id: "1" },
              running: false,
            },
          ],
        },
        80,
      ),
    );

    expect(lines.some((line) => line.includes("Bash(ls -la)"))).toBe(true);
    expect(lines.some((line) => line.includes("TaskUpdate"))).toBe(false);
    expect(lines.some((line) => line.trim().length === 0)).toBe(false);
  });

  it("truncates nested tool rows with an ellipsis at narrow widths", () => {
    const lines = plain(
      formatToolLines(
        {
          name: "Agent",
          args: { description: "x" },
          status: "running",
          payload: null,
          nested: [
            {
              toolName: "Bash",
              args: { command: "abcdefghijklmnopqrstuvwxyz" },
              running: true,
            },
          ],
        },
        20,
      ),
    );

    const nested = lines.find((line) => line.startsWith(GUTTER_HEAD));
    expect(nested).toContain("…");
    expect(nested).not.toContain("abcdefghijk");
  });
});

describe("the running tool bullet", () => {
  function head(status: ToolEntryData["status"], overrides: Partial<ToolEntryData> = {}): string {
    const lines = formatToolLines(
      { name: "Bash", args: { command: "sleep 30" }, status, payload: null, ...overrides },
      80,
    );
    return lines[0] ?? "";
  }

  function expectGlyph(
    line: string,
    glyph: string,
    color: NonNullable<(typeof Color)[keyof typeof Color]>,
    dim: boolean,
  ): void {
    expect(line).toContain(renderTextWithStyles(`${glyph} `, { color, dim }));
  }

  it("alternates the live bullet every 600 ms", () => {
    expect(stripAnsi(head("running", { elapsedMs: 0 }))).toStartWith(`${Glyph.bullet} Bash`);
    expect(stripAnsi(head("running", { elapsedMs: 599 }))).toStartWith(`${Glyph.bullet} Bash`);
    expect(stripAnsi(head("running", { elapsedMs: 600 }))).toStartWith("  Bash");
    expect(stripAnsi(head("running", { elapsedMs: 1_199 }))).toStartWith("  Bash");
    expect(stripAnsi(head("running", { elapsedMs: 1_200 }))).toStartWith(`${Glyph.bullet} Bash`);
  });

  it("uses muted dim glyphs for unresolved tools and terminal colours for results", () => {
    expectGlyph(head("queued", { elapsedMs: 0 }), Glyph.bullet, Color.muted, true);
    expectGlyph(head("running", { elapsedMs: 0 }), Glyph.bullet, Color.muted, true);
    expectGlyph(head("ok", { elapsedMs: 600 }), Glyph.bullet, Color.success, false);
    expectGlyph(head("error", { elapsedMs: 600 }), Glyph.bullet, Color.error, false);
  });

  it("keeps a steady bullet for completed, errored, backgrounded, and non-live tools", () => {
    expect(stripAnsi(head("ok", { elapsedMs: 600 }))).toStartWith(`${Glyph.bullet} Bash`);
    expect(stripAnsi(head("error", { elapsedMs: 600 }))).toStartWith(`${Glyph.bullet} Bash`);
    expect(stripAnsi(head("running"))).toStartWith(`${Glyph.bullet} Bash`);
    expect(stripAnsi(head("running", { elapsedMs: 600, isBackgrounded: true }))).toStartWith(
      `${Glyph.bullet} Bash`,
    );
    expectGlyph(
      head("running", { elapsedMs: 600, isBackgrounded: true }),
      Glyph.bullet,
      Color.muted,
      true,
    );
  });
});

/**
 * A server writes its own argument names and can hand over a whole script, so the
 * MCP header is the one whose length nothing upstream bounds. It spends the columns
 * left beside the tool name and stops there — the conversation above a call must
 * stay readable however large the payload was.
 */
describe("MCP tool header", () => {
  const WIRE_NAME = wireToolName("plugin:sample:sample", "run_script");

  beforeAll(() => {
    register({
      schema: { name: WIRE_NAME, description: "sample", inputSchema: { type: "object" } },
      run: async (call) => ({ tool_use_id: call.id, content: "", isError: false }),
      render: makeMcpRenderHooks("plugin:sample:sample", {
        name: "run_script",
        title: "Run Script",
        description: "sample",
      }),
    });
  });

  afterAll(() => {
    unregister(WIRE_NAME);
  });

  function mcpEntry(args: Record<string, unknown>): ToolEntryData {
    return { name: WIRE_NAME, args, status: "ok", payload: null };
  }

  it("holds a long argument to one row and marks the clip", () => {
    const script = `async () => { ${"const value = 1; ".repeat(200)} }`;
    const lines = plain(formatToolLines(mcpEntry({ script }), 100));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`${Glyph.bullet} plugin:sample:sample - Run Script (MCP)(script:`);
    expect(lines[0]).toEndWith("…");
    expect(stringWidth(lines[0] ?? "")).toBeLessThanOrEqual(100);
  });

  it("clips against the columns left beside the name, so a narrower frame shows less", () => {
    const script = `async () => { ${"const value = 1; ".repeat(200)} }`;
    const wide = plain(formatToolLines(mcpEntry({ script }), 120));
    const narrow = plain(formatToolLines(mcpEntry({ script }), 60));

    expect(wide).toHaveLength(1);
    expect(narrow).toHaveLength(1);
    expect(stringWidth(narrow[0] ?? "")).toBeLessThan(stringWidth(wide[0] ?? ""));
    expect(stringWidth(wide[0] ?? "")).toBeLessThanOrEqual(120);
    expect(stringWidth(narrow[0] ?? "")).toBeLessThanOrEqual(60);
  });

  it("leaves a short argument whole, brackets included", () => {
    const lines = plain(formatToolLines(mcpEntry({ url: "https://example.test" }), 100));

    expect(lines).toEqual([
      `${Glyph.bullet} plugin:sample:sample - Run Script (MCP)(url: "https://example.test")`,
    ]);
  });

  it("never splits a wide glyph across the clip boundary", () => {
    const lines = plain(formatToolLines(mcpEntry({ label: "廣".repeat(200) }), 80));

    expect(lines).toHaveLength(1);
    expect(stringWidth(lines[0] ?? "")).toBeLessThanOrEqual(80);
  });

  it("still wraps a non-MCP header, so the clip is scoped to MCP", () => {
    const description = "y".repeat(400);
    const lines = plain(
      formatToolLines(
        {
          name: "Agent",
          args: { subagent_type: "explore", description },
          status: "ok",
          payload: null,
        },
        80,
      ),
    );

    expect(lines.length).toBeGreaterThan(1);
  });
});
