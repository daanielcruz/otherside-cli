import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fail, notify, RPC_INVALID_PARAMS, success } from "@/design/bridge/envelope.ts";
import { activateDesignScope, isActiveDesignScope } from "@/design/scope.ts";
import {
  designStorageDir,
  isValidDesignId,
  loadDesignSnapshot,
  saveDesignSnapshot,
} from "@/design/storage.ts";
import type { DesignCapability, DesignSnapshot, JsonRpcId, RpcContext } from "@/design/types.ts";

interface DuplicateInput {
  sourceDesignId: string;
  newDesignId: string;
  title?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(params: unknown): DuplicateInput | string {
  if (!isRecord(params)) return "params must be an object";
  if (typeof params.sourceDesignId !== "string" || params.sourceDesignId.length === 0) {
    return "sourceDesignId must be a non-empty string";
  }
  if (typeof params.newDesignId !== "string" || params.newDesignId.length === 0) {
    return "newDesignId must be a non-empty string";
  }
  if (params.title !== undefined && typeof params.title !== "string") {
    return "title must be a string";
  }
  const sourceDesignId = params.sourceDesignId as string;
  const newDesignId = params.newDesignId as string;
  if (!isValidDesignId(sourceDesignId) || !isValidDesignId(newDesignId)) {
    return "designId contains unsafe characters";
  }
  const title = typeof params.title === "string" ? params.title.trim() : "";
  return {
    sourceDesignId,
    newDesignId,
    ...(title.length > 0 ? { title } : {}),
  };
}

function handle(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  const parsed = parse(params);
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }
  if (!isActiveDesignScope(ctx, parsed.sourceDesignId)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "sourceDesignId is not open"));
    return;
  }

  const existing =
    ctx.snapshots.get(parsed.sourceDesignId) ?? loadDesignSnapshot(ctx.cwd, parsed.sourceDesignId);
  if (!existing) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "unknown sourceDesignId"));
    return;
  }

  const origTitle = existing.title ?? "Untitled design";
  const newTitle = parsed.title ? parsed.title.trim() : `${origTitle} copy`;

  const cloned: DesignSnapshot = {
    ...existing,
    designId: parsed.newDesignId,
    title: newTitle,
    // The duplicate's title comes from an explicit user action, never the
    // auto-title pass — don't inherit the source's marker.
    titleIsAuto: false,
    updatedAt: new Date().toISOString(),
  };

  const sourceDir = designStorageDir(ctx.cwd, parsed.sourceDesignId);
  const destDir = designStorageDir(ctx.cwd, parsed.newDesignId);

  mkdirSync(destDir, { recursive: true });

  if (existsSync(sourceDir)) {
    for (const file of readdirSync(sourceDir)) {
      if (file.endsWith(".os.html")) {
        copyFileSync(join(sourceDir, file), join(destDir, file));
      }
    }
  }

  ctx.snapshots.set(parsed.newDesignId, cloned);
  saveDesignSnapshot(ctx.cwd, cloned);
  activateDesignScope(ctx, parsed.newDesignId);

  // Mirror design-open's snapshot emission so a client that switches straight
  // to the duplicate renders it without an extra design.open round-trip.
  ctx.emit(notify("$/snapshot", cloned));
  ctx.emit(notify("$/project-mutated", { title: cloned.title }));
  ctx.send(success(id, { ok: true, designId: parsed.newDesignId }));
}

export const DesignDuplicateCapability: DesignCapability = {
  name: "design.duplicate",
  rpcMethod: { method: "design.duplicate", handler: handle },
};
