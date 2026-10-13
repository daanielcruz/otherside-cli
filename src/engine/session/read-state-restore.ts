import { readFileSync, statSync } from "node:fs";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import { FILE_UNCHANGED_STUB } from "@/engine/tools/builtins/read/read.ts";
import { MAIN_SCOPE, restoreReadState } from "@/engine/tools/builtins/read/state.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const LINE_NUMBER_PREFIX = /^\s*\d+\t/;

type FileView =
  | { tool: "Read"; path: string }
  | { tool: "Write"; path: string; content: string }
  | { tool: "Edit"; path: string };

/**
 * Rebuilds which files the resumed conversation has seen, so an Edit or Write on a
 * file read before the process restarted is not refused as unread. Only whole-file
 * Reads count; the file on disk still has to match what the model saw.
 */
export function restoreReadStateFromRecords(records: readonly SessionRecord[]): void {
  const views = new Map<string, FileView>();
  for (const record of records) {
    if (record.type === "tool_call") {
      const view = fileViewOf(record.tool_name, record.args);
      if (view !== null) views.set(record.call_id, view);
      continue;
    }
    if (record.type !== "tool_result" || record.is_error) continue;
    const view = views.get(record.call_id);
    if (view === undefined) continue;
    const at = Date.parse(record.ts);
    if (view.tool === "Read") restoreRead(view.path, record.result, at);
    else if (view.tool === "Write") restoreReadState(MAIN_SCOPE, view.path, view.content, at);
    else restoreFromDisk(view.path);
  }
}

function fileViewOf(tool: string, args: unknown): FileView | null {
  if (!isRecord(args) || typeof args.file_path !== "string") return null;
  const path = args.file_path;
  if (tool === "Read") {
    return args.offset === undefined && args.limit === undefined ? { tool, path } : null;
  }
  if (tool === "Write") {
    return typeof args.content === "string" ? { tool, path, content: args.content } : null;
  }
  return tool === "Edit" ? { tool, path } : null;
}

function restoreRead(path: string, result: unknown, at: number): void {
  if (typeof result !== "string" || Number.isNaN(at)) return;
  if (result.startsWith(FILE_UNCHANGED_STUB) || result.startsWith("<system-reminder>")) return;
  const content = result
    .replace(SYSTEM_REMINDER, "")
    .split("\n")
    .map((line) => line.replace(LINE_NUMBER_PREFIX, ""))
    .join("\n")
    .trim();
  restoreReadState(MAIN_SCOPE, path, content, at);
}

function restoreFromDisk(path: string): void {
  try {
    restoreReadState(MAIN_SCOPE, path, readFileSync(path, "utf8"), statSync(path).mtimeMs);
  } catch {}
}
