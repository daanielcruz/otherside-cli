import { fail, notify, RPC_INVALID_PARAMS, success } from "@/design/bridge/envelope.ts";
import { activateDesignScope } from "@/design/scope.ts";
import {
  hasDesignSnapshotFile,
  isValidDesignId,
  loadDesignSnapshot,
  parseDesignSnapshot,
  saveDesignSnapshot,
} from "@/design/storage.ts";
import { isDesignTurnActive } from "@/design/turns.ts";
import type { DesignCapability, DesignSnapshot, JsonRpcId, RpcContext } from "@/design/types.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";

interface DesignOpenInput {
  designId?: string;
  /** The browser's own copy of the design, offered so this CLI can work on it. */
  snapshot?: DesignSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(params: unknown): DesignOpenInput | string {
  if (params === undefined || params === null) return {};
  if (!isRecord(params)) return "params must be an object";
  const input: DesignOpenInput = {};
  if (params.designId !== undefined) {
    if (typeof params.designId !== "string" || params.designId.length === 0) {
      return "designId must be a non-empty string";
    }
    if (!isValidDesignId(params.designId)) return "designId contains unsafe characters";
    input.designId = params.designId;
  }
  if (params.snapshot !== undefined) {
    const snapshot = parseDesignSnapshot(params.snapshot);
    if (!snapshot) return "snapshot is not a valid design";
    if (input.designId !== undefined && snapshot.designId !== input.designId) {
      return "snapshot belongs to a different designId";
    }
    input.snapshot = snapshot;
  }
  return input;
}

/**
 * The browser is the owner of a design; this CLI is where the AI works on it.
 * An offered copy replaces what is held here whenever it is newer, or when the
 * design is not held here at all. A local copy that is newer — a turn ended
 * after the browser last saved — is kept, and the browser receives it.
 */
function adoptOffered(ctx: RpcContext, offered: DesignSnapshot): DesignSnapshot {
  const held = ctx.snapshots.get(offered.designId) ?? loadDesignSnapshot(ctx.cwd, offered.designId);
  if (held && held.updatedAt > offered.updatedAt) return held;
  saveDesignSnapshot(ctx.cwd, offered);
  return offered;
}

function snapshotForOpen(
  ctx: RpcContext,
  designId: string,
  offered: DesignSnapshot | undefined,
): DesignSnapshot | null {
  const snapshot = offered
    ? adoptOffered(ctx, offered)
    : (ctx.snapshots.get(designId) ?? loadDesignSnapshot(ctx.cwd, designId));
  if (!snapshot) return null;
  // A turn that died mid-stream (crash, kill, restart) leaves the snapshot pinned
  // at "streaming", which the web renders as a perpetual "Composing…". On reopen
  // with no live turn, settle it so the design is usable again.
  if (snapshot.status === "streaming" && !isDesignTurnActive(designId)) {
    snapshot.status = "completed";
    saveDesignSnapshot(ctx.cwd, snapshot);
  }
  ctx.snapshots.set(designId, snapshot);
  return snapshot;
}

function designModel(
  ctx: RpcContext,
  snapshot: DesignSnapshot,
): { provider: string | undefined; model: string | undefined; effort: EffortLevel | null } {
  const broker = ctx.broker.read();
  return {
    provider: snapshot.provider ?? broker.provider,
    model: snapshot.model ?? broker.model,
    effort: snapshot.effort !== undefined ? (snapshot.effort as EffortLevel | null) : broker.effort,
  };
}

function handle(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  const parsed = parse(params);
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }
  const designId = parsed.designId ?? parsed.snapshot?.designId ?? ctx.designId;
  const snapshot = snapshotForOpen(ctx, designId, parsed.snapshot);
  if (!snapshot) {
    // Distinguish a design that never existed here from one whose snapshot
    // file is present but unreadable — the two need different follow-ups.
    const reason = hasDesignSnapshotFile(ctx.cwd, designId)
      ? "design snapshot is unreadable"
      : "unknown designId";
    ctx.send(fail(id, RPC_INVALID_PARAMS, reason));
    return;
  }
  activateDesignScope(ctx, designId);
  ctx.emit(notify("$/snapshot", snapshot));
  ctx.emit(notify("$/metadata", { current: designModel(ctx, snapshot) }));
  ctx.send(success(id, { designId, snapshot }));
}

export const DesignOpenCapability: DesignCapability = {
  name: "design.open",
  rpcMethod: {
    method: "design.open",
    handler: handle,
  },
};
