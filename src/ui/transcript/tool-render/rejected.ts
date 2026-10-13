import { createPatch } from "diff";
import {
  USER_REJECTED_TOOL_RESULT,
  USER_REJECTED_WITH_FEEDBACK_PREFIX,
} from "@/engine/queue/runtime/rejection-text.ts";
import { getDisplayPath } from "@/kernel/std/fs/paths.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import { countLines } from "@/ui/transcript/tool-render/format.ts";
import { WRITE_MAX_LINES_TO_RENDER } from "@/ui/transcript/tool-render/payload.ts";
import type { ToolPayload } from "@/ui/transcript/tool-render/types.ts";

/** What a rejected call's row reads when its tool has no view of the change it proposed. */
export const TOOL_USE_REJECTED_LABEL = "Tool use rejected";

/**
 * The row of a call the user turned down at its prompt, or null for any other result.
 * A file change shows what was not applied; any other call reads as interrupted when
 * the rejection ended the turn, and as rejected when the user gave directions.
 */
export function rejectedToolPayload(name: string, args: unknown, text: string): ToolPayload | null {
  const endedTurn = text.startsWith(USER_REJECTED_TOOL_RESULT);
  if (!endedTurn && !text.startsWith(USER_REJECTED_WITH_FEEDBACK_PREFIX)) return null;
  const change = rejectedChangePayload(name, args);
  if (change) return change;
  return endedTurn ? { kind: "interrupt" } : { kind: "hint", text: TOOL_USE_REJECTED_LABEL };
}

function rejectedChangePayload(name: string, args: unknown): ToolPayload | null {
  if (!isRecord(args) || typeof args.file_path !== "string") return null;
  const path = getDisplayPath(args.file_path);
  if (name === "Write" && typeof args.content === "string") {
    return { kind: "hint", text: rejectedWriteText(path, args.content) };
  }
  if (
    name === "Edit" &&
    typeof args.old_string === "string" &&
    typeof args.new_string === "string"
  ) {
    return {
      kind: "diff",
      fragment: createPatch(path, args.old_string, args.new_string, "", "", { context: 3 }),
      filePath: args.file_path,
      header: `User rejected update to ${path}`,
    };
  }
  return null;
}

function rejectedWriteText(path: string, content: string): string {
  const lines = content.split("\n").slice(0, countLines(content));
  const shown = lines.slice(0, WRITE_MAX_LINES_TO_RENDER);
  const digits = String(shown.length).length;
  const numbered = shown.map((line, index) => `  ${String(index + 1).padStart(digits)} ${line}`);
  const hidden = lines.length - shown.length;
  const more = hidden > 0 ? [`  … +${hidden} ${hidden === 1 ? "line" : "lines"}`] : [];
  return [`User rejected write to ${path}`, ...numbered, ...more].join("\n");
}
