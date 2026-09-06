import { relative } from "node:path";
import { parseWorkflowScript } from "@/engine/background/workflows/runtime/parser/meta.ts";
import type { WorkflowPhaseSpec } from "@/engine/background/workflows/runtime/parser/types.ts";
import { destructiveCommandWarning } from "@/engine/tools/index.ts";
import { get as getToolHandler } from "@/engine/tools/registry.ts";
import { userFacingToolName } from "@/engine/tools/tool-label.ts";
import {
  FORK_ROUTE_PERMISSION_TOOL,
  type PendingPermission,
} from "@/kernel/channels/permission.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { wrapAnsi, wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { Color, Glyph } from "@/ui/theme/theme.ts";

/** Phases shown before the prompt; a deeper script reports the count it withholds. */
const WORKFLOW_PHASE_PREVIEW = 6;
const WORKFLOW_DETAIL_CLIP = 72;
const WORKFLOW_ARGS_CLIP = 120;

/**
 * What a workflow costs, stated before it is approved. A run spawns subagents in
 * parallel and each one bills, so the number the user is agreeing to is invisible
 * without this — the gate is worthless if it only names the tool.
 */
export const WORKFLOW_USAGE_WARNING =
  "A dynamic workflow can spend tokens fast: it runs many subagents at once and every one of them counts against your usage. Stop a run at any time with /workflows, or turn dynamic workflows off in /config.";

interface McpDisplay {
  label: string;
  args: string;
  description: string;
}

interface ToolPresentation {
  title: string;
  question: string;
  body: string[];
  warning: string | null;
}

export function toolPresentation(pending: PendingPermission, width: number): ToolPresentation {
  const input = inputRecord(pending.input);
  const signature = toolSignature(pending);
  const mcp = mcpDisplayFor(pending);
  if (mcp !== null) {
    const body = styledRawLines(
      `${mcp.label}${mcp.args ? `(${mcp.args})` : ""} (MCP)`,
      width,
      Color.text,
    );
    if (mcp.description.length > 0) {
      body.push(...styledProseLines(clipLines(mcp.description, 3), width, Color.muted));
    }
    return { title: "Tool use", question: "Do you want to proceed?", body, warning: null };
  }

  switch (pending.toolName) {
    case "Bash": {
      const command = inputString(input, "command");
      const description = inputString(input, "description");
      const body = styledRawLines(command.length > 0 ? command : signature, width, Color.text);
      if (description.length > 0) {
        body.push(...styledProseLines(description, width, Color.muted));
      }
      return {
        title: "Bash command",
        question: "Do you want to proceed?",
        body,
        warning: command.length > 0 ? destructiveCommandWarning(command) : null,
      };
    }
    case "Edit":
    case "MultiEdit": {
      const file = displayPath(inputString(input, "file_path"));
      return {
        title: "Edit file",
        question:
          file.length > 0 ? `Do you want to make this edit to ${file}?` : "Do you want to proceed?",
        body: styledRawLines(file.length > 0 ? file : signature, width, Color.text),
        warning: null,
      };
    }
    case "Write": {
      const file = displayPath(inputString(input, "file_path"));
      return {
        title: "Write file",
        question: file.length > 0 ? `Do you want to write ${file}?` : "Do you want to proceed?",
        body: styledRawLines(file.length > 0 ? file : signature, width, Color.text),
        warning: null,
      };
    }
    case "Read": {
      const file = displayPath(inputString(input, "file_path"));
      return {
        title: "Read file",
        question: "Do you want to proceed?",
        body: styledRawLines(file.length > 0 ? file : signature, width, Color.text),
        warning: null,
      };
    }
    case FORK_ROUTE_PERMISSION_TOOL: {
      const requested = `${inputString(input, "requested_provider")}/${inputString(input, "requested_model")}`;
      const session = `${inputString(input, "session_provider")}/${inputString(input, "session_model")}`;
      const costWarning = inputString(input, "warning");
      return {
        title: "Agent model route",
        question: `Run this agent on ${requested} instead of ${session}?`,
        body: styledRawLines(`agent: ${requested}\nsession: ${session}`, width, Color.text),
        warning: costWarning.length > 0 ? costWarning : null,
      };
    }
    case "Workflow":
      return {
        title: "Dynamic workflow",
        question: "Do you want to run it?",
        body: workflowBody(input, signature, width),
        warning: WORKFLOW_USAGE_WARNING,
      };
    case "WebFetch": {
      const url = inputString(input, "url");
      const prompt = inputString(input, "prompt");
      const body = styledRawLines(url.length > 0 ? url : signature, width, Color.text);
      if (prompt.length > 0) body.push(...styledProseLines(prompt, width, Color.muted));
      return {
        title: "Fetch",
        question: "Do you want to allow Otherside to fetch this content?",
        body,
        warning: null,
      };
    }
    default:
      return {
        title: "Tool use",
        question: "Do you want to proceed?",
        body: styledRawLines(signature, width, Color.text),
        warning: null,
      };
  }
}

/**
 * What the run is and what it will spawn. A named workflow arrives without its
 * script, so the phases are shown when the caller inlined one and the identity
 * carries the row otherwise — never a guess at phases we cannot read.
 */
function workflowBody(input: Record<string, unknown>, signature: string, width: number): string[] {
  const script = inputString(input, "script");
  const meta = script.length > 0 ? workflowMetaOf(script) : null;
  const identity = meta?.name ?? (inputString(input, "name") || inputString(input, "scriptPath"));
  const body = styledRawLines(identity.length > 0 ? identity : signature, width, Color.text);

  const description = meta?.description ?? "";
  if (description.length > 0) body.push(...styledProseLines(description, width, Color.muted));

  const phases = meta?.phases ?? [];
  if (phases.length > 0) {
    body.push("");
    body.push(
      ...styledProseLines("The run will spawn subagents across these phases:", width, Color.text),
    );
    for (const phase of phases.slice(0, WORKFLOW_PHASE_PREVIEW)) {
      body.push(...styledRawLines(`  ${phaseLabel(phase)}`, width, Color.text));
    }
    const withheld = phases.length - WORKFLOW_PHASE_PREVIEW;
    if (withheld > 0) {
      body.push(...styledRawLines(`  … ${withheld} more`, width, Color.muted));
    }
  }

  const args = workflowArgsText(input.args);
  if (args.length > 0) {
    body.push("");
    body.push(...styledRawLines(`args: ${args}`, width, Color.muted));
  }
  return body;
}

function phaseLabel(phase: WorkflowPhaseSpec): string {
  const detail = phase.detail ?? "";
  const title = `${phase.index + 1}. ${phase.title}`;
  return detail.length > 0 ? `${title} — ${truncateEllipsis(detail, WORKFLOW_DETAIL_CLIP)}` : title;
}

/** A script the parser rejects still deserves the warning, so it degrades to no meta. */
function workflowMetaOf(script: string): ReturnType<typeof parseWorkflowScript>["meta"] | null {
  try {
    return parseWorkflowScript(script).meta;
  } catch {
    return null;
  }
}

function workflowArgsText(args: unknown): string {
  if (args === undefined || args === null) return "";
  const text = typeof args === "string" ? args : safeJson(args);
  return text.length > 0 ? truncateEllipsis(text, WORKFLOW_ARGS_CLIP) : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function mcpDisplayFor(
  pending: Pick<PendingPermission, "toolName" | "input">,
): McpDisplay | null {
  if (!isMcpToolName(pending.toolName)) return null;
  const hooks = getToolHandler(pending.toolName)?.render;
  const full = hooks?.userFacingLabel?.(pending.input) ?? userFacingToolName(pending.toolName);
  const suffix = " (MCP)";
  return {
    label: full.endsWith(suffix) ? full.slice(0, -suffix.length) : full,
    args: hooks?.summarizeArgs?.(pending.input) ?? "",
    description: hooks?.userFacingDescription?.() ?? "",
  };
}

export function permissionTitle(title: string, source: PendingPermission["source"]): string {
  if (source === undefined) return title;
  const name = source.name.trim();
  const attribution =
    name.length > 0 ? `from the ${truncateEllipsis(name, 24)} agent` : "from a subagent";
  return `${title}${Glyph.divider}${attribution}`;
}

export function toolSignature(
  pending: Pick<PendingPermission, "toolName" | "argsPreview">,
): string {
  const display = userFacingToolName(pending.toolName);
  return `${display}${pending.argsPreview ? `(${pending.argsPreview})` : ""}`;
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function inputString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function displayPath(file: string): string {
  if (file.length === 0) return file;
  try {
    const rel = relative(process.cwd(), file);
    return rel.length > 0 && !rel.startsWith("..") ? rel : file;
  } catch {
    return file;
  }
}

function clipLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}…`;
}

export function extractPlan(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const plan = (input as Record<string, unknown>).plan;
  return typeof plan === "string" && plan.length > 0 ? plan : null;
}

export function styledRawLines(text: string, width: number, color: typeof Color.text): string[] {
  return wrapExplicitLines(text, width, wrapRawLine).map((line) =>
    renderTextWithStyles(line, { color }),
  );
}

export function styledProseLines(text: string, width: number, color: typeof Color.text): string[] {
  return wrapExplicitLines(text, width, wrapProse).map((line) =>
    renderTextWithStyles(line, { color }),
  );
}

function wrapExplicitLines(
  text: string,
  width: number,
  wrapLine: (line: string, columns: number) => string[],
): string[] {
  const columns = Math.max(1, width);
  const output: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      output.push("");
      continue;
    }
    output.push(...wrapLine(line, columns));
  }
  return output.length > 0 ? output : [""];
}

function wrapRawLine(line: string, columns: number): string[] {
  return wrapAnsi(line, columns, { hard: true, trim: false, wordWrap: true }).split("\n");
}
