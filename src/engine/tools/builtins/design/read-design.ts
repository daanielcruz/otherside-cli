import { existsSync } from "node:fs";
import { join } from "node:path";
import { designStorageDir, loadDesignSnapshot } from "@/design/storage.ts";
import type { DesignSnapshot } from "@/design/types.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import ReadDesignSchema from "@/harness/tools/ReadDesign/tool.json" with { type: "json" };
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface Input {
  design_id?: unknown;
  file_path?: unknown;
  offset?: unknown;
  limit?: unknown;
}

const DEFAULT_LIMIT = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function ok(toolUseId: string, content: string): ToolResult {
  return { tool_use_id: toolUseId, content };
}

function isIncomplete(snapshot: DesignSnapshot): boolean {
  return snapshot.status !== "completed" || snapshot.files.length === 0;
}

function incompleteNote(snapshot: DesignSnapshot): string {
  return (
    `WARNING: this design is incomplete (status: ${snapshot.status}, files: ${snapshot.files.length}). ` +
    `Content may still be streaming in; what follows is the latest saved state.`
  );
}

function inventory(snapshot: DesignSnapshot): string {
  const lines = [
    `Design: ${snapshot.title ?? "Untitled design"}`,
    `Status: ${snapshot.status}`,
    `Provider/model: ${snapshot.provider ?? "unknown"} / ${snapshot.model ?? "unknown"}`,
    `Updated: ${snapshot.updatedAt}`,
    "",
    `Files (${snapshot.files.length}):`,
    ...snapshot.files.map((file) => {
      const size = file.content?.length ?? 0;
      return `- ${file.path} (${size} chars)`;
    }),
  ];
  if (isIncomplete(snapshot)) lines.unshift(incompleteNote(snapshot), "");
  return lines.join("\n");
}

function readFileSlice(
  snapshot: DesignSnapshot,
  filePath: string,
  offset: number,
  limit: number,
): string | null {
  const file = snapshot.files.find((candidate) => candidate.path === filePath);
  if (!file) return null;
  const content = file.content ?? "";
  const all = content.split("\n");
  const slice = all.slice(offset, offset + limit);
  const parts: string[] = [];
  if (isIncomplete(snapshot)) parts.push(incompleteNote(snapshot), "");
  parts.push(slice.join("\n"));
  const remaining = all.length - (offset + slice.length);
  if (remaining > 0) {
    parts.push(
      "",
      `[truncated: ${remaining} more lines — continue with offset=${offset + slice.length}]`,
    );
  }
  return parts.join("\n");
}

export const ReadDesign: ToolHandler = {
  schema: {
    name: ReadDesignSchema.name,
    description: ReadDesignSchema.description,
    inputSchema: ReadDesignSchema.inputSchema,
  },
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as Input;
    const designId = typeof args.design_id === "string" ? args.design_id.trim() : "";
    if (!UUID_RE.test(designId)) {
      return err(call.id, "`design_id` must be a UUID (as shown in the design handoff)");
    }
    const filePath = typeof args.file_path === "string" ? args.file_path : null;
    const offset =
      typeof args.offset === "number" && Number.isInteger(args.offset) && args.offset >= 0
        ? args.offset
        : 0;
    const limit =
      typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit >= 1
        ? Math.min(args.limit, DEFAULT_LIMIT)
        : DEFAULT_LIMIT;

    const cwd = ctx.originalCwd ?? ctx.cwd;
    const snapshotPath = join(designStorageDir(cwd, designId), "snapshot.json");
    if (!existsSync(snapshotPath)) {
      return err(
        call.id,
        `Design ${designId} not found for this project. Designs are project-scoped: ` +
          `make sure the session runs in the project where the design was created.`,
      );
    }
    const snapshot = loadDesignSnapshot(cwd, designId);
    if (!snapshot) {
      return err(
        call.id,
        `Design ${designId} exists but its saved snapshot is corrupt or has an unrecognized shape.`,
      );
    }
    if (filePath === null) return ok(call.id, inventory(snapshot));
    const slice = readFileSlice(snapshot, filePath, offset, limit);
    if (slice === null) {
      const available = snapshot.files.map((file) => file.path).join(", ") || "(none)";
      return err(
        call.id,
        `File "${filePath}" is not part of design ${designId}. Available: ${available}`,
      );
    }
    return ok(call.id, slice);
  },
};
