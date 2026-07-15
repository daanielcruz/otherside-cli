import { beforeAll, describe, expect, it } from "bun:test";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { Edit } from "@/engine/tools/builtins/edit/edit.ts";
import { cellAtIndex, type Screen } from "@/terminal-runtime/paint/cell-grid.ts";
import { paintToTerminal } from "@/terminal-runtime/paint/screen-diff.ts";
import { TerminalSizeContext } from "@/terminal-runtime/react/dimensions-context.tsx";
import { Glyph } from "@/ui/theme/theme.ts";
import {
  type ToolPayload,
  ToolRender,
  type ToolRenderProps,
} from "@/ui/transcript/tool-render/index.tsx";
import type { NestedEntry } from "@/ui/transcript/tool-render/types.ts";

const WIDTH = 40;
const NESTED_WIDTH = 60;

beforeAll(() => {
  registerAllProviders();
});

interface RenderOptions {
  nested?: NestedEntry[];
  payload?: ToolPayload;
  elapsedMs?: number;
}

function renderRows(options: RenderOptions = {}): string[] {
  const { nested = [], payload, elapsedMs } = options;
  const payloadProps = payload === undefined ? {} : { payload };
  const elapsedProps = elapsedMs === undefined ? {} : { elapsedMs };
  const el = (
    <TerminalSizeContext.Provider value={{ columns: NESTED_WIDTH, rows: 36 }}>
      <ToolRender
        name="Agent"
        args={{ subagent_type: "general-purpose", description: "task harness" }}
        status="running"
        providerShortKey="gemini"
        agentSuffix="GPT-5.5"
        nestedEntries={nested}
        {...payloadProps}
        {...elapsedProps}
      />
    </TerminalSizeContext.Provider>
  );
  const { screen } = paintToTerminal(el, NESTED_WIDTH);
  return screenToRows(screen);
}

function renderToolScreen(props: ToolRenderProps, width = WIDTH): Screen {
  const el = (
    <TerminalSizeContext.Provider value={{ columns: width, rows: 36 }}>
      <ToolRender {...props} />
    </TerminalSizeContext.Provider>
  );
  return paintToTerminal(el, width).screen;
}

function renderToolRows(props: ToolRenderProps, width = WIDTH): string[] {
  return screenToRows(renderToolScreen(props, width));
}

function screenToRows(screen: Screen): string[] {
  const rows: string[] = [];
  for (let y = 0; y < screen.height; y++) {
    let line = "";
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAtIndex(screen, y * screen.width + x);
      line += cell.char.length > 0 ? cell.char : " ";
    }
    rows.push(line.replace(/\s+$/, ""));
  }
  return rows;
}

const nested = (toolName: string): NestedEntry => ({
  toolName,
  args: { command: "very_long_command_that_exceeds_forty_characters_and_triggers_wrapping" },
  running: true,
});

describe("running-agent nested progress", () => {
  it("hides empty-named nested tools instead of leaving a bare gutter line", () => {
    const rows = renderRows({ nested: [nested("TaskCreate"), nested("TaskUpdate")] });
    expect(rows.some((r) => r.trim().length === 0)).toBe(false);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain("Initializing…");
  });

  it("keeps real nested tools visible", () => {
    const rows = renderRows({ nested: [nested("Bash"), nested("Bash")] });
    expect(rows.filter((r) => r.includes("Bash("))).toHaveLength(2);
    expect(rows.some((r) => r.trim().length === 0)).toBe(false);
  });

  it("drops only empty-named tools from a mixed list", () => {
    const rows = renderRows({ nested: [nested("Bash"), nested("TaskUpdate")] });
    expect(rows.filter((r) => r.includes("Bash("))).toHaveLength(1);
    expect(rows.some((r) => r.trim().length === 0)).toBe(false);
  });

  it("does not duplicate active tool and agent timers", () => {
    const rows = renderRows({
      nested: [nested("Bash")],
      payload: { kind: "progress", text: "Running… (1m 59s · timeout 2m)" },
      elapsedMs: 158_000,
    });
    expect(rows.some((r) => r.includes("Running… (1m 59s · timeout 2m)"))).toBe(true);
    expect(rows.some((r) => r.includes("2m 38s"))).toBe(false);
  });

  it("renders only the tool-call header for completed nested tools — never result content", () => {
    const entry: NestedEntry = {
      toolName: "Bash",
      args: { command: "echo hello" },
      running: false,
    };
    const rows = renderRows({ nested: [entry] });
    // Agent header + nested header + background hint — no line for the result.
    const visible = rows.filter((r) => r.trim().length > 0);
    expect(visible).toHaveLength(3);
    expect(visible[1]).toContain("Bash(echo hello)");
  });
});

describe("tool producer attribution", () => {
  it("limits model hints to Agent, GenerateImage, and vision-assisted Read", () => {
    const common = {
      status: "ok" as const,
      providerShortKey: "codex",
      producedModel: "gpt-5.6-luna",
    };

    const bash = renderToolRows({
      ...common,
      name: "Bash",
      args: { command: "echo hello" },
    });
    expect(bash.join("\n")).toContain("Bash(echo hello)");
    expect(bash.join("\n")).not.toContain("gpt-5.6-luna");

    const agent = renderToolRows({
      ...common,
      name: "Agent",
      args: { prompt: "review this" },
    });
    expect(agent.join("\n")).toContain("gpt-5.6-luna");

    const generated = renderToolRows({
      ...common,
      name: "GenerateImage",
      args: { prompt: "a blue circle" },
    });
    expect(generated.join("\n")).toContain("gpt-5.6-luna");

    const read = renderToolRows({
      ...common,
      name: "Read",
      args: { file_path: "/fixture.png" },
      visionModel: "Gemini Vision",
    });
    expect(read.join("\n")).not.toContain("gpt-5.6-luna");
    expect(read.join(" ").replace(/\s+/g, " ")).toContain("Vision by Gemini Vision");
  });
});

describe("tool header wrapping", () => {
  it("wraps a hyperlinked Update path without dropping text", () => {
    const previous = process.env.FORCE_HYPERLINK;
    process.env.FORCE_HYPERLINK = "1";
    try {
      const filePath =
        "/tool-render-fixture/workflows/scripts/ai-two-feature-master-plan-workflow.js";
      const screen = renderToolScreen({
        name: "Edit",
        args: { file_path: filePath, old_string: "old", new_string: "new" },
        status: "ok",
        providerShortKey: "anthropic",
        hooks: Edit.render!,
      });
      const rows = screenToRows(screen);
      let linkedText = "";
      for (let i = 0; i < screen.width * screen.height; i += 1) {
        const cell = cellAtIndex(screen, i);
        if (cell.hyperlink !== undefined) linkedText += cell.char;
      }

      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.length > 0)).toBe(true);
      expect(rows.map((row) => row.trimStart()).join("")).toBe(
        `${Glyph.bullet} Update(${filePath})`,
      );
      expect(linkedText).toBe(filePath);
    } finally {
      if (previous === undefined) delete process.env.FORCE_HYPERLINK;
      else process.env.FORCE_HYPERLINK = previous;
    }
  });
});
