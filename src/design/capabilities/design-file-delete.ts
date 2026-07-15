import { fail, notify, RPC_INVALID_PARAMS, success } from "@/design/bridge/envelope.ts";
import { isActiveDesignScope } from "@/design/scope.ts";
import { isValidDesignId, loadDesignSnapshot, saveDesignSnapshot } from "@/design/storage.ts";
import type {
  DesignCapability,
  DesignSnapshotArtifact,
  JsonRpcId,
  RpcContext,
} from "@/design/types.ts";
import { stableArtifactId } from "@/design/types.ts";

interface DesignFileDeleteInput {
  designId: string;
  path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(params: unknown, fallbackDesignId: string): DesignFileDeleteInput | string {
  if (!isRecord(params)) return "params must be an object";
  const designId =
    typeof params.designId === "string" && params.designId.length > 0
      ? params.designId
      : fallbackDesignId;
  if (!isValidDesignId(designId)) return "designId contains unsafe characters";
  if (typeof params.path !== "string" || params.path.length === 0) {
    return "path must be a non-empty string";
  }
  return { designId, path: params.path };
}

function artifactOwnsPath(
  artifact: DesignSnapshotArtifact,
  designId: string,
  path: string,
): boolean {
  return (
    artifact.artifactId === stableArtifactId(designId, path) || artifact.metadata?.path === path
  );
}

function handle(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  const parsed = parse(params, ctx.activeDesignId ?? "");
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }
  if (!isActiveDesignScope(ctx, parsed.designId)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "designId is not open"));
    return;
  }
  const snapshot =
    ctx.snapshots.get(parsed.designId) ?? loadDesignSnapshot(ctx.cwd, parsed.designId);
  if (!snapshot) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "unknown designId"));
    return;
  }
  if (!snapshot.files.some((file) => file.path === parsed.path)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "unknown file path"));
    return;
  }

  const files = snapshot.files.filter((file) => file.path !== parsed.path);
  const activeFileTab =
    snapshot.viewState.activeFileTab === parsed.path
      ? (files[0]?.path ?? null)
      : snapshot.viewState.activeFileTab;
  const openFiles = snapshot.viewState.openFiles.filter((path) => path !== parsed.path);
  if (activeFileTab && !openFiles.includes(activeFileTab)) openFiles.push(activeFileTab);
  const updatedAt = new Date().toISOString();
  const next = {
    ...snapshot,
    files,
    artifacts: snapshot.artifacts.filter(
      (artifact) => !artifactOwnsPath(artifact, parsed.designId, parsed.path),
    ),
    viewState: {
      ...snapshot.viewState,
      activeFileTab,
      openFiles,
    },
    updatedAt,
  };
  ctx.snapshots.set(parsed.designId, next);
  saveDesignSnapshot(ctx.cwd, next);
  ctx.emit(notify("$/project-mutated", { deletedPaths: [parsed.path] }));
  ctx.send(success(id, { ok: true, path: parsed.path }));
}

export const DesignFileDeleteCapability: DesignCapability = {
  name: "design.file.delete",
  rpcMethod: { method: "design.file.delete", handler: handle },
};
