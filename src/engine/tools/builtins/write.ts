import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createPatch } from "diff";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import { WriteSchema } from "@/engine/tools/dynamic/Write.ts";
import { emitEnvBroadcast } from "@/kernel/channels/session-events.ts";
import { chmodIfPosix, renameReplaceSync } from "@/kernel/std/fs/secure-fs.ts";
import {
  applyLineEndings,
  defaultLineEndings,
  detectLineEndings,
} from "@/kernel/std/text/line-endings.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  recordFileMutationResult,
  snapshotBeforeFileMutation,
} from "@/kernel/storage/file-history.ts";
import { isNetworkSharePath, NETWORK_SHARE_PATH_ERROR } from "./path-guards.ts";
import { readScopeKey, readState, updateReadState } from "./read/state.ts";

interface WriteInput {
  file_path?: unknown;
  content?: unknown;
}

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

export const Write: ToolHandler = {
  schema: WriteSchema,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as WriteInput;
    const filePath = typeof args.file_path === "string" ? args.file_path : null;
    const content = typeof args.content === "string" ? args.content : null;
    if (!filePath) return err(call.id, "missing or non-string `file_path`");
    if (content == null) return err(call.id, "missing or non-string `content`");
    if (isNetworkSharePath(filePath)) return err(call.id, NETWORK_SHARE_PATH_ERROR);
    if (!isAbsolute(filePath)) {
      return err(call.id, `\`file_path\` must be absolute: ${filePath}`);
    }

    const scope = readScopeKey(ctx);
    const parent = dirname(filePath);
    try {
      mkdirSync(parent, { recursive: true });
    } catch (e) {
      return err(call.id, `failed to create parent dirs: ${(e as Error).message}`);
    }

    const existed = existsSync(filePath);
    let priorContent = "";
    if (existed) {
      try {
        priorContent = await Bun.file(filePath).text();
      } catch {}
    }
    let priorMode: number | null = null;
    if (existed) {
      try {
        priorMode = statSync(filePath).mode & 0o777;
      } catch {}
      const recorded = readState(scope, filePath);
      if (recorded) {
        let currentMtime = recorded.timestamp;
        try {
          currentMtime = statSync(filePath).mtimeMs;
        } catch {}
        if (currentMtime > recorded.timestamp) {
          let currentContent = "";
          try {
            currentContent = await Bun.file(filePath).text();
          } catch {}
          if (currentContent !== recorded.content) {
            return err(
              call.id,
              "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
            );
          }
        }
      }
    }
    await snapshotBeforeFileMutation(ctx, filePath);

    const pid = process.pid;
    const nanos = process.hrtime.bigint().toString();
    const baseName = filePath.slice(parent.length + 1);
    const stagePath = join(parent, `${baseName}.otherside.${pid}.${nanos}.tmp`);

    try {
      if (existsSync(stagePath)) unlinkSync(stagePath);
    } catch {}

    const endings =
      existed && priorContent.length > 0 ? detectLineEndings(priorContent) : defaultLineEndings();
    const finalContent = applyLineEndings(content, endings);

    try {
      await Bun.write(stagePath, finalContent);
      chmodIfPosix(stagePath, priorMode ?? 0o644);
      renameReplaceSync(stagePath, filePath);
    } catch (e) {
      try {
        if (existsSync(stagePath)) unlinkSync(stagePath);
      } catch {}
      return err(call.id, `atomic write failed: ${(e as Error).message}`);
    }

    recordFileMutationResult(ctx, filePath);
    updateReadState(scope, filePath, finalContent);

    const numLines = content.length === 0 ? 0 : content.split("\n").length;
    const fileName = basename(filePath);
    const diff = createPatch(fileName, priorContent, content, "", "", { context: 3 });

    emitEnvBroadcast(JSON.stringify({ op: "diff", path: filePath, diff, call_id: call.id }));

    return {
      tool_use_id: call.id,
      content: JSON.stringify({
        status: "ok",
        file_path: filePath,
        created: !existed,
        bytes_written: Buffer.byteLength(content, "utf8"),
        numLines,
        diff,
      }),
    };
  },
};
