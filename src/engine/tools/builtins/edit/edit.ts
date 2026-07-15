import { statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { createPatch } from "diff";
import type { ToolArgSegment, ToolHandler } from "@/engine/tools/contract.ts";
import { filePathSegment } from "@/engine/tools/contract.ts";
import EditSchema from "@/harness/tools/Edit/tool.json" with { type: "json" };
import { emitEnvBroadcast } from "@/kernel/channels/session-events.ts";
import { chmodIfPosix } from "@/kernel/std/fs/secure-fs.ts";
import { applyLineEndings, detectLineEndings } from "@/kernel/std/text/line-endings.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  recordFileMutationResult,
  snapshotBeforeFileMutation,
} from "@/kernel/storage/file-history.ts";
import { isNetworkSharePath, NETWORK_SHARE_PATH_ERROR } from "../path-guards.ts";
import { readScopeKey, readSetContains, readState, updateReadState } from "../read/state.ts";
import { normalizeEditStrings } from "./string-normalize.ts";

interface EditInput {
  file_path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
}

function isReplaceAll(value: unknown): boolean {
  return value === true || value === "true";
}

export function getEditToolDescription(opts: { lean?: boolean } = {}): string {
  return opts.lean ? EditSchema.description.lean : EditSchema.description.full;
}

export const Edit: ToolHandler = {
  schema: {
    name: EditSchema.name,
    description: getEditToolDescription({ lean: true }),
    inputSchema: EditSchema.inputSchema,
  },
  render: {
    userFacingName(input) {
      const obj = (input ?? {}) as Record<string, unknown>;
      if (typeof obj.old_string === "string" && obj.old_string === "") return "Create";
      return "Update";
    },
    summarizeArgSegments(input) {
      const obj = (input ?? {}) as Record<string, unknown>;
      const fp = typeof obj.file_path === "string" ? obj.file_path : "";
      const segments: ToolArgSegment[] = [filePathSegment(fp)];
      if (isReplaceAll(obj.replace_all)) segments.push({ kind: "text", text: " · all" });
      return segments;
    },
  },
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as EditInput;
    const filePath = typeof args.file_path === "string" ? args.file_path : null;
    const oldString = typeof args.old_string === "string" ? args.old_string : null;
    const newString = typeof args.new_string === "string" ? args.new_string : null;
    const replaceAllFlag = isReplaceAll(args.replace_all);

    if (!filePath) return err(call.id, "missing or non-string `file_path`");
    if (oldString == null) return err(call.id, "missing or non-string `old_string`");
    if (newString == null) return err(call.id, "missing or non-string `new_string`");
    if (oldString === newString) {
      return err(call.id, "`new_string` must differ from `old_string`");
    }
    if (isNetworkSharePath(filePath)) return err(call.id, NETWORK_SHARE_PATH_ERROR);
    if (!isAbsolute(filePath)) {
      return err(call.id, `\`file_path\` must be absolute: ${filePath}`);
    }
    if (filePath.toLowerCase().endsWith(".ipynb")) {
      return err(
        call.id,
        "File is a Jupyter Notebook. Use the NotebookEdit tool to edit this file.",
      );
    }
    const scope = readScopeKey(ctx);
    if (!readSetContains(scope, filePath)) {
      return err(call.id, "File has not been read yet. Read it first before writing to it.");
    }

    try {
      const stat = statSync(filePath);
      if (stat.size > 1024 * 1024 * 1024) {
        return err(call.id, `file too large to edit safely: ${stat.size} bytes (max 1 GiB)`);
      }
    } catch {}

    let contents: string;
    try {
      contents = await Bun.file(filePath).text();
    } catch (e) {
      return err(call.id, `failed to read ${filePath}: ${(e as Error).message}`);
    }

    const recorded = readState(scope, filePath);
    if (recorded) {
      let currentMtime = recorded.timestamp;
      try {
        currentMtime = statSync(filePath).mtimeMs;
      } catch {}
      if (currentMtime > recorded.timestamp && contents !== recorded.content) {
        return err(
          call.id,
          "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
        );
      }
    }

    const { oldString: matchOld, newString: matchNew } = normalizeEditStrings({
      filePath,
      fileContent: contents,
      oldString,
      newString,
    });

    const matches = countOccurrences(contents, matchOld);
    if (matches === 0) {
      return err(
        call.id,
        `\`old_string\` not found in ${filePath}. The file may have changed since you last read it — Read it again and retry with the current text.`,
      );
    }
    if (matches > 1 && !replaceAllFlag) {
      return err(
        call.id,
        `\`old_string\` appears ${matches} times — pass \`replace_all: true\` or supply more context`,
      );
    }

    const updated = replaceAllFlag
      ? replaceAll(contents, matchOld, matchNew)
      : replaceFirst(contents, matchOld, matchNew);
    const endings = detectLineEndings(contents);
    const finalContent = applyLineEndings(updated, endings);
    await snapshotBeforeFileMutation(ctx, filePath);

    let priorMode: number | null = null;
    try {
      priorMode = statSync(filePath).mode & 0o777;
    } catch {}

    try {
      await Bun.write(filePath, finalContent);
    } catch (e) {
      return err(call.id, `failed to write ${filePath}: ${(e as Error).message}`);
    }

    if (priorMode != null) chmodIfPosix(filePath, priorMode);
    recordFileMutationResult(ctx, filePath);

    updateReadState(scope, filePath, updated);

    const fileName = basename(filePath);
    const diff = createPatch(fileName, contents, updated, "", "", { context: 3 });

    emitEnvBroadcast(JSON.stringify({ op: "diff", path: filePath, diff, call_id: call.id }));

    return {
      tool_use_id: call.id,
      content: JSON.stringify({
        status: "ok",
        file_path: filePath,
        replaced: replaceAllFlag ? matches : 1,
        diff,
      }),
    };
  },
};
