import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";
import { createPatch } from "diff";
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
import type { LabelSegment } from "@/ui/panels/permission/options.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { displayNameFor } from "@/ui/transcript/tool-render/args.ts";
import { renderDiffAnsiLines } from "@/ui/transcript/tool-render/diff.ts";
import { expandTabsForRender } from "@/ui/transcript/tool-render/format.ts";

/** Phases shown before the prompt; a deeper script reports the count it withholds. */
const WORKFLOW_PHASE_PREVIEW = 6;
const WORKFLOW_DETAIL_CLIP = 72;
const WORKFLOW_ARGS_CLIP = 120;
/** Rows of a file preview shown before the question; a longer one reports the rest. */
const FILE_PREVIEW_ROWS = 20;

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

/** Columns a command, request or other call sits in from the prompt's own rows. */
const CALL_INSET = 2;
/** Columns a file read sits in: one closer to the rows, since it names a path, not a command. */
const READ_INSET = 1;

export interface ToolPresentation {
  title: string;
  /** Asked right above the choices; a file the call touches is set bold. */
  question: readonly LabelSegment[];
  /** The call itself: a command, a request, a file's path. */
  body: string[];
  /** Columns the body sits in from the prompt's own rows. */
  bodyInset: number;
  /**
   * A file's new lines or its diff. The body then hugs the title, and the preview
   * runs edge to edge in a dashed frame directly over the question.
   */
  preview: string[] | null;
  /** Why this call needs approval, stated between the call and the question. */
  reason: string | null;
  warning: string | null;
}

export function toolPresentation(pending: PendingPermission, width: number): ToolPresentation {
  return { ...callPresentation(pending, width), reason: pending.reason ?? null };
}

/**
 * A fetch is answered by its choices alone: its "No" already says how to go on, so
 * no note rides on an answer and no key hints sit under the choices.
 */
export function answeredByChoicesAlone(pending: PendingPermission): boolean {
  return pending.toolName === "WebFetch";
}

function plainQuestion(text: string): readonly LabelSegment[] {
  return [{ text }];
}

type CallPresentation = Omit<ToolPresentation, "reason">;

function callShape(
  title: string,
  body: string[],
  options: { question?: string; bodyInset?: number; warning?: string | null } = {},
): CallPresentation {
  return {
    title,
    question: plainQuestion(options.question ?? "Do you want to proceed?"),
    body,
    bodyInset: options.bodyInset ?? CALL_INSET,
    preview: null,
    warning: options.warning ?? null,
  };
}

function callPresentation(pending: PendingPermission, width: number): CallPresentation {
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
    return callShape("Tool use", body);
  }

  switch (pending.toolName) {
    case "Bash": {
      const command = inputString(input, "command");
      const description = inputString(input, "description");
      const body = styledRawLines(command.length > 0 ? command : signature, width, Color.text);
      if (description.length > 0) {
        body.push(...styledProseLines(description, width, Color.muted));
      }
      return callShape("Bash command", body, {
        warning: command.length > 0 ? destructiveCommandWarning(command) : null,
      });
    }
    case "Edit":
    case "MultiEdit":
    case "Write": {
      const filePath = inputString(input, "file_path");
      if (filePath.length === 0) break;
      const preview = filePreview(pending.toolName, input, filePath);
      return {
        title: preview.title,
        question: [
          { text: `Do you want to ${preview.action} ` },
          { text: basename(filePath), bold: true },
          { text: "?" },
        ],
        body: styledRawLines(displayPath(filePath), width, Color.muted),
        bodyInset: 0,
        preview: previewRows(preview, filePath, width),
        warning: null,
      };
    }
    case "Read": {
      const file = displayPath(inputString(input, "file_path"));
      return callShape(
        "Read file",
        styledRawLines(file.length > 0 ? `Read(${file})` : signature, width, Color.text),
        { bodyInset: READ_INSET },
      );
    }
    case FORK_ROUTE_PERMISSION_TOOL: {
      const requested = `${inputString(input, "requested_provider")}/${inputString(input, "requested_model")}`;
      const session = `${inputString(input, "session_provider")}/${inputString(input, "session_model")}`;
      const costWarning = inputString(input, "warning");
      return callShape(
        "Agent model route",
        styledRawLines(`agent: ${requested}\nsession: ${session}`, width, Color.text),
        {
          question: `Run this agent on ${requested} instead of ${session}?`,
          warning: costWarning.length > 0 ? costWarning : null,
        },
      );
    }
    case "Workflow":
      return callShape("Dynamic workflow", workflowBody(input, signature, width), {
        question: "Do you want to run it?",
        warning: WORKFLOW_USAGE_WARNING,
      });
    case "WebFetch": {
      const url = inputString(input, "url");
      const prompt = inputString(input, "prompt");
      const request = [
        `url: ${normalizedUrl(url)}`,
        ...(prompt.length > 0 ? [`prompt: ${prompt}`] : []),
      ];
      return callShape(
        "Fetch",
        [
          ...styledRawLines(request.join("\n"), width, Color.text),
          ...styledProseLines(
            `Otherside wants to fetch content from ${hostOf(url)}`,
            width,
            Color.muted,
          ),
        ],
        { question: "Do you want to allow Otherside to fetch this content?" },
      );
    }
    case "WebSearch": {
      const query = inputString(input, "query");
      const description = `Otherside wants to search the web for: ${query}`;
      return callShape("Tool use", [
        ...styledRawLines(
          `${displayNameFor(pending.toolName, input)}("${query}")`,
          width,
          Color.text,
        ),
        ...wrapProse(description, Math.max(1, width - 2)).map(
          (line) =>
            `${renderTextWithStyles(Glyph.boxPipe, { dim: true })} ${renderTextWithStyles(line, { color: Color.muted })}`,
        ),
      ]);
    }
  }
  return callShape("Tool use", styledRawLines(signature, width, Color.text));
}

/** What an edit will do to its file, read once per call at the moment it is asked. */
type FilePreview =
  | { title: "Create file"; action: "create"; content: string }
  | {
      title: "Overwrite file" | "Edit file";
      action: "overwrite" | "make this edit to";
      patch: string;
    };

const filePreviews = new WeakMap<object, FilePreview>();

function filePreview(
  toolName: string,
  input: Record<string, unknown>,
  filePath: string,
): FilePreview {
  const cached = filePreviews.get(input);
  if (cached !== undefined) return cached;
  const preview = computeFilePreview(toolName, input, filePath);
  filePreviews.set(input, preview);
  return preview;
}

function computeFilePreview(
  toolName: string,
  input: Record<string, unknown>,
  filePath: string,
): FilePreview {
  const name = basename(filePath);
  const prior = fileContent(filePath);
  if (toolName === "Write") {
    const content = inputString(input, "content");
    if (prior === null) return { title: "Create file", action: "create", content };
    return {
      title: "Overwrite file",
      action: "overwrite",
      patch: createPatch(name, prior, content, "", "", { context: 3 }),
    };
  }
  const edits = editsOf(input);
  const edited = prior === null ? null : applyEdits(prior, edits);
  // An edit whose text is not in the file yet still shows the change it asks for.
  const patch =
    prior !== null && edited !== null
      ? createPatch(name, prior, edited, "", "", { context: 3 })
      : createPatch(
          name,
          edits.map((edit) => edit.oldString).join("\n"),
          edits.map((edit) => edit.newString).join("\n"),
          "",
          "",
          { context: 3 },
        );
  return { title: "Edit file", action: "make this edit to", patch };
}

interface TextEdit {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

function editsOf(input: Record<string, unknown>): TextEdit[] {
  const entries = Array.isArray(input.edits) ? input.edits : [input];
  return entries.map((entry) => {
    const edit = inputRecord(entry);
    return {
      oldString: inputString(edit, "old_string"),
      newString: inputString(edit, "new_string"),
      replaceAll: edit.replace_all === true,
    };
  });
}

function applyEdits(content: string, edits: readonly TextEdit[]): string | null {
  let result = content;
  for (const edit of edits) {
    if (edit.oldString.length === 0 || !result.includes(edit.oldString)) return null;
    result = edit.replaceAll
      ? result.split(edit.oldString).join(edit.newString)
      : result.replace(edit.oldString, () => edit.newString);
  }
  return result;
}

function fileContent(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function previewRows(preview: FilePreview, filePath: string, width: number): string[] {
  const rows =
    "content" in preview
      ? numberedRows(preview.content, width)
      : (renderDiffAnsiLines(preview.patch, width, filePath)?.bodyLines ?? []);
  if (rows.length <= FILE_PREVIEW_ROWS) return rows;
  const withheld = rows.length - FILE_PREVIEW_ROWS;
  return [
    ...rows.slice(0, FILE_PREVIEW_ROWS),
    renderTextWithStyles(`… +${withheld} line${withheld === 1 ? "" : "s"}`, { color: Color.muted }),
  ];
}

/** A new file's lines under dim line numbers, each cut to one row. */
function numberedRows(content: string, width: number): string[] {
  const lines = content.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const digits = String(lines.length).length;
  return lines.map((line, index) => {
    const number = ` ${String(index + 1).padStart(digits)} `;
    const text = truncateEllipsis(expandTabsForRender(line), Math.max(1, width - number.length));
    return (
      renderTextWithStyles(number, { color: Color.text, dim: true }) +
      renderTextWithStyles(text, { color: Color.text })
    );
  });
}

/** Rows set between two dashed rules, apart from the prompt's own text. */
/** The address as it will be requested, e.g. with the path `/` a bare host implies. */
function normalizedUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
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
