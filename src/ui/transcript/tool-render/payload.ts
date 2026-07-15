import { stringWidth } from "@/kernel/std/text/string-width.ts";
import type { ToolResultMeta } from "@/kernel/std/types/message.ts";
import { osc8UrlLink } from "@/ui/transcript/markdown/osc8.ts";
import {
  displayNameFor,
  formatNumberCompact,
  summarizeArgs,
  supportsHyperlinks,
} from "@/ui/transcript/tool-render/args.ts";
import {
  countLines,
  formatByteSize,
  formatDurationMs,
  mcpSizeWarning,
  normalizeNewlines,
  oneLinePreview,
  trimMultiline,
  tryFlattenJson,
  tryFormatJsonContent,
  tryUnwrapTextPayload,
  type UnwrappedTextPayload,
} from "@/ui/transcript/tool-render/format.ts";
import type { NestedEntry, ToolPayload } from "@/ui/transcript/tool-render/types.ts";

const URL_PATTERN = /https?:\/\/[^\s)]+/g;

function linkifyUrls(text: string): string {
  if (!supportsHyperlinks()) return text;
  return text.replace(URL_PATTERN, (url) => osc8UrlLink({ url, label: url }));
}

export const TOOL_USE_ERROR_TAG = /^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/;
export const SANDBOX_VIOLATION_TAG = /<\/?sandbox_violation>/g;
export const ERROR_TAG = /<\/?error>/g;

export function payloadFromError(err: string): ToolPayload {
  const match = err.match(TOOL_USE_ERROR_TAG);
  const extracted = match ? (match[1] ?? "") : err;
  const cleaned = extracted.replace(SANDBOX_VIOLATION_TAG, "").replace(ERROR_TAG, "").trim();

  let normalized: string;
  if (cleaned.startsWith("Error: ") || cleaned.startsWith("Cancelled: ")) {
    normalized = cleaned;
  } else {
    normalized = `Error: ${cleaned}`;
  }

  return { kind: "preview", text: normalized };
}

export function mcpTextPayloadPreview(payload: UnwrappedTextPayload): ToolPayload {
  if (payload.extras.length === 0) return { kind: "preview", text: payload.body };
  const extrasLine = payload.extras.map(([key, value]) => `${key}: ${value}`).join(" · ");
  return { kind: "preview", text: `${extrasLine}\n${payload.body}` };
}

export function mcpFlatPreview(entries: [string, string][]): ToolPayload {
  const maxKeyWidth = Math.max(...entries.map(([key]) => stringWidth(key)));
  const lines = entries.map(([key, value]) => `${key.padEnd(maxKeyWidth)}: ${value}`);
  return { kind: "preview", text: lines.join("\n") };
}

export function payloadFromResult(
  name: string,
  content: string,
  args: unknown,
  isError = false,
): ToolPayload | null {
  const base = basePayloadFromResult(name, content, args, isError);
  if (isError || !name.startsWith("mcp__") || base?.kind !== "preview") return base;
  const warning = mcpSizeWarning(content);
  const linked = linkifyUrls(base.text);
  return { kind: "preview", text: warning ? `${warning}\n${linked}` : linked };
}

export function payloadFromMeta(meta: ToolResultMeta): ToolPayload | null {
  if (meta.kind === "bash") {
    if (meta.sed_edit && meta.sed_edit.diff.length > 0) {
      return {
        kind: "diff",
        fragment: meta.sed_edit.diff,
        filePath: meta.sed_edit.file_path,
      };
    }
    return bashPreview(meta);
  }
  if (meta.kind === "read") return readPreview(meta);
  if (meta.kind === "image") {
    return { kind: "preview", text: `Read image (${formatByteSize(meta.bytes)})` };
  }
  return null;
}

export function basePayloadFromResult(
  name: string,
  content: string,
  args: unknown,
  isError = false,
): ToolPayload | null {
  const parsed = tryParseJson(content);
  if (parsed === undefined) {
    if (name === "Skill" && !isError) {
      return { kind: "preview", text: "Successfully loaded skill" };
    }
    if (name === "Read" && content.startsWith("File unchanged since last read") && !isError) {
      return { kind: "preview", text: "Unchanged since last read" };
    }
    if (name === "Read" && content.length > 0 && !isError) {
      const lines = countLines(content);
      return {
        kind: "preview",
        text: `Read ${lines} ${lines === 1 ? "line" : "lines"}`,
      };
    }
    if (name === "TaskOutput") {
      const preview = taskOutputPreview(content);
      if (preview !== null) return preview;
    }
    if (isError) return null;
    return rawTextPreview(content, name.startsWith("mcp__"));
  }
  if (name.startsWith("mcp__")) {
    const unwrapped = tryUnwrapTextPayload(content);
    if (unwrapped !== null) return mcpTextPayloadPreview(unwrapped);
    const flat = tryFlattenJson(content);
    if (flat !== null) return mcpFlatPreview(flat);
    return rawTextPreview(content, true);
  }
  switch (name) {
    case "Edit":
      return diffPayload(parsed, args) ?? editPreview(parsed);
    case "Write":
      return diffPayload(parsed, args) ?? writePreview(parsed, args);
    case "Read":
      return readPreview(parsed) ?? previewPayload(parsed);
    case "Bash":
      return bashPreview(parsed) ?? previewPayload(parsed);
    case "Skill":
      return skillPreview(parsed) ?? previewPayload(parsed);
    case "ToolSearch":
      return toolSearchPreview(parsed) ?? previewPayload(parsed);
    case "Agent":
      return agentPreview(parsed) ?? previewPayload(parsed);
    case "WebFetch":
      return webFetchPreview(parsed) ?? previewPayload(parsed);
    case "WebSearch":
      return webSearchPreview(parsed) ?? previewPayload(parsed);
    case "NotebookEdit":
      return notebookEditPreview(parsed) ?? previewPayload(parsed);
    default:
      return previewPayload(parsed);
  }
}

export function tryParseJson(content: string): unknown | undefined {
  if (content.length === 0) return undefined;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && trimmed !== "null") return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

export function rawTextPreview(content: string, isMcp = false): ToolPayload | null {
  if (content.length === 0) return null;
  if (isMcp) {
    return { kind: "preview", text: tryFormatJsonContent(content) };
  }
  if (content.includes("\n")) {
    return { kind: "preview", text: trimMultiline(content, 20, 200) };
  }
  return { kind: "preview", text: oneLinePreview(content, 240) };
}

import { isRecord } from "@/kernel/std/value-guards.ts";

export function diffPayload(result: unknown, args?: unknown): ToolPayload | null {
  if (!isRecord(result)) return null;
  const filePath = readFilePathFromArgs(args);
  const diff = typeof result.diff === "string" ? result.diff : null;
  if (diff && diff.length > 0) {
    return filePath ? { kind: "diff", fragment: diff, filePath } : { kind: "diff", fragment: diff };
  }
  const unified = typeof result.unified_diff === "string" ? result.unified_diff : null;
  if (unified && unified.length > 0) {
    return filePath
      ? { kind: "diff", fragment: unified, filePath }
      : { kind: "diff", fragment: unified };
  }
  return null;
}

export function readFilePathFromArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const v = args.file_path ?? args.path;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function readPreview(result: unknown): ToolPayload | null {
  if (!isRecord(result)) return null;
  if (result.unchanged === true) return { kind: "preview", text: "Unchanged since last read" };
  const kind = typeof result.type === "string" ? result.type : "";
  const sizeBytes = typeof result.bytes === "number" ? result.bytes : undefined;
  const sizeLabel = sizeBytes !== undefined ? formatByteSize(sizeBytes) : null;
  if (kind === "image") {
    return {
      kind: "preview",
      text: `Read image${sizeLabel ? ` (${sizeLabel})` : ""}`,
    };
  }
  if (kind === "pdf") {
    return {
      kind: "preview",
      text: `Read PDF${sizeLabel ? ` (${sizeLabel})` : ""}`,
    };
  }
  if (kind === "notebook") {
    const n = typeof result.numCells === "number" ? result.numCells : null;
    if (n !== null) {
      return {
        kind: "preview",
        text: `Read ${n} ${n === 1 ? "cell" : "cells"}`,
      };
    }
  }
  if (kind === "pdfPages") {
    const n = typeof result.numPages === "number" ? result.numPages : null;
    if (n !== null) {
      return {
        kind: "preview",
        text: `Read ${n} ${n === 1 ? "page" : "pages"}${sizeLabel ? ` (${sizeLabel})` : ""}`,
      };
    }
  }
  const num = typeof result.numLines === "number" ? result.numLines : null;
  if (num === null) return null;
  return {
    kind: "preview",
    text: `Read ${num} ${num === 1 ? "line" : "lines"}`,
  };
}

export function editPreview(result: unknown): ToolPayload | null {
  if (!isRecord(result)) return null;
  const fp = typeof result.file_path === "string" ? result.file_path : "";
  const replaced = typeof result.replaced === "number" ? result.replaced : null;
  const text =
    replaced !== null
      ? `${replaced} replacement${replaced === 1 ? "" : "s"} in ${fp}`
      : `Updated ${fp}`;
  return text.trim().length === 0 ? null : { kind: "preview", text };
}

export const WRITE_MAX_LINES_TO_RENDER = 10;

export function writeLineCount(
  result: Record<string, unknown>,
  argsContent: string | null,
): number | null {
  if (typeof result.numLines === "number") return result.numLines;
  if (typeof result.lines === "number") return result.lines;
  if (argsContent) return countLines(argsContent);
  return null;
}

export function writePreview(result: unknown, args: unknown): ToolPayload | null {
  if (!isRecord(result)) return null;
  const argFp = isRecord(args) && typeof args.file_path === "string" ? args.file_path : "";
  const fp = typeof result.file_path === "string" ? result.file_path : argFp;
  const argsContent = isRecord(args) && typeof args.content === "string" ? args.content : null;
  const lines = writeLineCount(result, argsContent);
  const bytes = typeof result.bytes_written === "number" ? result.bytes_written : null;

  let header: string;
  if (lines !== null && fp.length > 0) header = `Wrote ${lines} lines to ${fp}`;
  else if (lines !== null) header = `Wrote ${lines} lines`;
  else if (bytes !== null && fp.length > 0)
    header = `Wrote ${bytes} byte${bytes === 1 ? "" : "s"} to ${fp}`;
  else if (bytes !== null) header = `Wrote ${bytes} bytes`;
  else if (fp.length > 0) header = `Wrote ${fp}`;
  else return null;

  if (!argsContent || argsContent.length === 0) return { kind: "preview", text: header };
  const total = countLines(argsContent);
  const previewLines = argsContent.split("\n").slice(0, WRITE_MAX_LINES_TO_RENDER).join("\n");
  const plus = Math.max(0, total - WRITE_MAX_LINES_TO_RENDER);
  let text = `${header}\n${previewLines}`;
  if (plus > 0) text += `\n… +${plus} ${plus === 1 ? "line" : "lines"}`;
  return { kind: "preview", text };
}

export function bashPreview(result: unknown): ToolPayload | null {
  if (!isRecord(result)) return null;
  if (result.status === "background") {
    return { kind: "hint", text: "Running in the background (↓ to manage)" };
  }
  const summary = isRecord(result.search_summary) ? result.search_summary : null;
  if (summary && typeof summary.lines === "number") {
    const exit = typeof result.exit_code === "number" ? result.exit_code : 0;
    if (exit === 0) {
      const n = summary.lines as number;
      return {
        kind: "preview",
        text: n === 0 ? "0 lines" : `${n} line${n === 1 ? "" : "s"}`,
      };
    }
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : null;
  const stderr = typeof result.stderr === "string" ? result.stderr : null;
  const legacy = typeof result.output === "string" ? result.output : null;
  if (stdout === null && stderr === null && legacy === null) return null;
  const exit = typeof result.exit_code === "number" ? result.exit_code : 0;
  let so = stdout ?? "";
  let se = stderr ?? "";
  if (stdout === null && stderr === null && legacy !== null) {
    if (exit !== 0) {
      so = "";
      se = legacy;
    } else {
      so = legacy;
      se = "";
    }
  }
  const SANDBOX_VIOLATION_BLOCK = /\n?<sandbox_violations>[\s\S]*?<\/sandbox_violations>\n?/g;
  se = se.replace(SANDBOX_VIOLATION_BLOCK, "");
  so = tryFormatJsonContent(normalizeNewlines(so));
  se = tryFormatJsonContent(normalizeNewlines(se));
  const noOutputExpected = result.no_output_expected === true;
  const returnCodeInterpretation =
    typeof result.return_code_interpretation === "string"
      ? result.return_code_interpretation
      : undefined;
  if (so.length === 0 && se.length === 0 && exit === 0) {
    return {
      kind: "bash",
      stdout: noOutputExpected ? "Done" : "(No output)",
      stderr: "",
      exitCode: exit,
      ...(noOutputExpected ? { noOutputExpected: true } : {}),
      ...(returnCodeInterpretation !== undefined ? { returnCodeInterpretation } : {}),
    };
  }
  return {
    kind: "bash",
    stdout: so,
    stderr: se,
    exitCode: exit,
    ...(noOutputExpected ? { noOutputExpected: true } : {}),
    ...(returnCodeInterpretation !== undefined ? { returnCodeInterpretation } : {}),
  };
}

export function taskOutputPreview(content: string): ToolPayload | null {
  const tag = (n: string): string | null => {
    const m = content.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`));
    return m && m[1] !== undefined ? m[1] : null;
  };
  const status = tag("retrieval_status");
  if (status === null) return null;
  const taskStatus = tag("status");
  const exitCode = tag("exit_code");
  const output = tag("output");
  const error = tag("error");

  const parts: string[] = [];
  if (status === "not_ready") parts.push("still running");
  else if (status === "timeout") parts.push("wait timed out");
  else if (status === "not_found") parts.push("task not found");
  else if (status === "success") {
    if (taskStatus) parts.push(taskStatus);
    if (exitCode !== null) parts.push(`exit ${exitCode}`);
  } else {
    parts.push(status);
  }
  if (output !== null && output.trim().length > 0) {
    const lines = countLines(output);
    parts.push(`${lines} ${lines === 1 ? "line" : "lines"} output`);
  }
  if (error !== null && error.trim().length > 0) {
    parts.push(`error: ${oneLinePreview(error, 60)}`);
  }
  return { kind: "preview", text: parts.join(" · ") };
}

export function skillPreview(result: unknown): ToolPayload | null {
  if (!isRecord(result)) return null;
  if (result.forked === true) return { kind: "preview", text: "Done" };
  const parts: string[] = ["Successfully loaded skill"];
  const tools = Array.isArray(result.tools) ? result.tools : null;
  if (tools) {
    parts.push(`${tools.length} ${tools.length === 1 ? "tool" : "tools"} allowed`);
  } else if (typeof result.tool_count === "number") {
    const n = result.tool_count;
    parts.push(`${n} ${n === 1 ? "tool" : "tools"} allowed`);
  }
  const model = typeof result.model === "string" ? result.model : "";
  if (model.length > 0) parts.push(model);
  return { kind: "preview", text: parts.join(" · ") };
}

export function toolSearchPreview(result: unknown): ToolPayload | null {
  if (!isRecord(result)) return null;
  const tools = Array.isArray(result.tools) ? result.tools : null;
  if (!tools) return null;
  const n = tools.length;
  const head = `Found ${n} ${n === 1 ? "tool" : "tools"}`;
  if (tools.length === 0) return { kind: "preview", text: head };
  const names: string[] = [];
  for (const t of tools) {
    if (isRecord(t) && typeof t.name === "string") names.push(t.name);
  }
  if (names.length === 0) return { kind: "preview", text: head };
  const shown = names.slice(0, 10);
  const tail = names.length > shown.length ? `, +${names.length - shown.length} more` : "";
  return { kind: "preview", text: `${head}: ${shown.join(", ")}${tail}` };
}

export function httpCodeTail(code: number | null, codeText: string): string | null {
  if (code === null) return null;
  if (codeText.length > 0) return `(${code} ${codeText})`;
  return `(${code})`;
}

export function webFetchPreview(result: unknown): ToolPayload | null {
  if (!isRecord(result)) return null;
  const bytes = typeof result.bytes === "number" ? result.bytes : null;
  const code = typeof result.code === "number" ? result.code : null;
  const codeText = typeof result.codeText === "string" ? result.codeText : "";
  const size = bytes !== null ? formatByteSize(bytes) : null;
  const tail = httpCodeTail(code, codeText);
  if (size && tail) return { kind: "preview", text: `Received ${size} ${tail}` };
  if (size) return { kind: "preview", text: `Received ${size}` };
  if (tail) return { kind: "preview", text: `Received ${tail}` };
  return null;
}

export function webSearchPreview(result: unknown): ToolPayload | null {
  if (!isRecord(result)) return null;
  const results = Array.isArray(result.results) ? result.results : null;
  if (!results) return null;
  if (results.length === 1) {
    const first = results[0];
    if (typeof first === "string" && first.startsWith("web_search_unavailable")) {
      return { kind: "preview", text: oneLinePreview(first, 240) };
    }
  }
  let count = 0;
  for (const v of results) {
    if (v === null) continue;
    if (typeof v === "string" && v.length === 0) continue;
    count++;
  }
  const dur = typeof result.durationSeconds === "number" ? result.durationSeconds : 0;
  const time = dur >= 1 ? `${Math.round(dur)}s` : `${Math.round(dur * 1000)}ms`;
  const plural = count === 1 ? "" : "es";
  return { kind: "preview", text: `Did ${count} search${plural} in ${time}` };
}

export function notebookEditPreview(result: unknown): ToolPayload | null {
  if (!isRecord(result)) return null;
  if (typeof result.error === "string") {
    return { kind: "preview", text: oneLinePreview(result.error, 240) };
  }
  const cell = typeof result.cell_id === "string" ? result.cell_id : "";
  const newSource = typeof result.new_source === "string" ? result.new_source : "";
  if (cell.length === 0 && newSource.length === 0) return null;
  const header = cell.length === 0 ? "Updated cell" : `Updated cell ${cell}`;
  if (newSource.length === 0) return { kind: "preview", text: header };
  return {
    kind: "preview",
    text: `${header}\n${trimMultiline(newSource, 5, 180)}`,
  };
}

export function agentPreview(result: unknown): ToolPayload | null {
  if (!isRecord(result)) return null;
  const status = typeof result.status === "string" ? result.status : "unknown";
  if (status === "completed") {
    const tu = typeof result.totalToolUseCount === "number" ? result.totalToolUseCount : 0;
    const tokens = typeof result.totalTokens === "number" ? result.totalTokens : 0;
    const dur = typeof result.totalDurationMs === "number" ? result.totalDurationMs : 0;
    return {
      kind: "preview",
      text: `Done (${tu} tool use${tu === 1 ? "" : "s"} · ${formatNumberCompact(tokens)} tokens · ${formatDurationMs(dur)})`,
    };
  }
  if (status === "backgrounded") {
    return { kind: "hint", text: "Backgrounded agent (↓ to manage)" };
  }
  const reason =
    typeof result.reason === "string" ? result.reason : "agent dispatch returned no result";
  return { kind: "preview", text: oneLinePreview(reason, 240) };
}

export function previewPayload(result: unknown): ToolPayload | null {
  if (typeof result === "string") {
    return rawTextPreview(result);
  }
  if (Array.isArray(result)) {
    return {
      kind: "preview",
      text: `${result.length} item${result.length === 1 ? "" : "s"}`,
    };
  }
  if (isRecord(result)) {
    if (typeof result.numFiles === "number") {
      return {
        kind: "preview",
        text: `${result.numFiles} file${result.numFiles === 1 ? "" : "s"}`,
      };
    }
    if (Array.isArray(result.matches)) {
      const n = result.matches.length;
      return { kind: "preview", text: `${n} match${n === 1 ? "" : "es"}` };
    }
    if (Array.isArray(result.files)) {
      const n = result.files.length;
      return { kind: "preview", text: `${n} file${n === 1 ? "" : "s"}` };
    }
    if (typeof result.output === "string") {
      const exit = typeof result.exit_code === "number" ? result.exit_code : 0;
      const prefix = exit === 0 ? "" : `exit ${exit}:\n`;
      return {
        kind: "preview",
        text: `${prefix}${trimMultiline(result.output, 20, 200)}`,
      };
    }
    if (typeof result.content === "string") {
      return { kind: "preview", text: oneLinePreview(result.content, 240) };
    }
    if (typeof result.message === "string") {
      return { kind: "preview", text: oneLinePreview(result.message, 240) };
    }
    if (typeof result.error === "string") {
      return { kind: "preview", text: oneLinePreview(result.error, 240) };
    }
    const n = Object.keys(result).length;
    return { kind: "preview", text: `${n} field${n === 1 ? "" : "s"}` };
  }
  if (result === null) return null;
  return { kind: "preview", text: String(result) };
}

export function formatNestedEntry(entry: NestedEntry): [string, string] {
  const label = displayNameFor(entry.toolName, entry.args);
  const inner = summarizeArgs(entry.toolName, entry.args);
  return [label, inner];
}
