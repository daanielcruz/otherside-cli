import { fail, notify, RPC_INVALID_PARAMS, success } from "@/design/bridge/envelope.ts";
import { isActiveDesignScope } from "@/design/scope.ts";
import {
  isValidDesignId,
  listDesigns,
  loadDesignSnapshot,
  saveDesignSnapshot,
} from "@/design/storage.ts";
import type {
  DesignCapability,
  DesignSnapshot,
  DesignSnapshotArtifact,
  DesignSnapshotFile,
  JsonRpcId,
  RpcContext,
} from "@/design/types.ts";
import { stableArtifactId } from "@/design/types.ts";

const DEFAULT_DESIGN_PATH = "design.os.html";

interface SaveEntry {
  doc: string;
  path?: string | undefined;
  title?: string | undefined;
}

interface SaveInput {
  designId: string;
  entries: SaveEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSaveEntry(value: unknown): SaveEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.doc !== "string" || value.doc.trim().length === 0) return null;
  return {
    doc: value.doc,
    ...(typeof value.path === "string" && value.path.length > 0 ? { path: value.path } : {}),
    ...(typeof value.title === "string" && value.title.length > 0 ? { title: value.title } : {}),
  };
}

function parseSave(params: unknown, fallbackDesignId: string): SaveInput | string {
  if (!isRecord(params)) return "params must be an object";
  const designId =
    typeof params.designId === "string" && params.designId.length > 0
      ? params.designId
      : fallbackDesignId;
  if (!isValidDesignId(designId)) return "designId contains unsafe characters";
  if (Array.isArray(params.files)) {
    const entries = params.files.map(parseSaveEntry).filter((entry) => entry !== null);
    if (entries.length === 0) return "files must contain at least one { doc } entry";
    return { designId, entries };
  }
  const single = parseSaveEntry(params);
  if (!single) return "doc must be a non-empty string";
  return { designId, entries: [single] };
}

function artifactPath(snapshot: DesignSnapshot, requested: string | undefined): string {
  return (
    requested ?? snapshot.viewState.activeFileTab ?? snapshot.files[0]?.path ?? DEFAULT_DESIGN_PATH
  );
}

function upsertFile(files: DesignSnapshotFile[], file: DesignSnapshotFile): DesignSnapshotFile[] {
  const index = files.findIndex((entry) => entry.path === file.path);
  if (index === -1) return [...files, file];
  return files.map((entry, current) => (current === index ? file : entry));
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function upsertArtifact(
  artifacts: DesignSnapshotArtifact[],
  artifact: DesignSnapshotArtifact,
  path: string,
): DesignSnapshotArtifact[] {
  const byId = artifacts.findIndex((entry) => entry.artifactId === artifact.artifactId);
  if (byId !== -1) {
    return artifacts.map((entry, current) => (current === byId ? artifact : entry));
  }
  const byPath = artifacts.findIndex((entry) => metadataString(entry.metadata, "path") === path);
  if (byPath !== -1) {
    return artifacts.map((entry, current) => (current === byPath ? artifact : entry));
  }
  return [...artifacts, artifact];
}

function snapshotForSave(ctx: RpcContext, input: SaveInput): DesignSnapshot | null {
  const existing = ctx.snapshots.get(input.designId) ?? loadDesignSnapshot(ctx.cwd, input.designId);
  if (!existing) return null;
  ctx.snapshots.set(input.designId, existing);
  return existing;
}

function updateSnapshotForSave(ctx: RpcContext, input: SaveInput): DesignSnapshot | string {
  let snapshot = snapshotForSave(ctx, input);
  if (!snapshot) return "unknown designId";
  const updatedAt = new Date().toISOString();
  const savedFiles: DesignSnapshotFile[] = [];
  const savedArtifacts: DesignSnapshotArtifact[] = [];
  for (const entry of input.entries) {
    const path = artifactPath(snapshot, entry.path);
    const artifactId = stableArtifactId(input.designId, path);
    const existing = snapshot.artifacts.find(
      (item) => item.artifactId === artifactId || metadataString(item.metadata, "path") === path,
    );
    const title = entry.title ?? metadataString(existing?.metadata, "title");
    const file: DesignSnapshotFile = {
      path,
      content: entry.doc,
      status: "modified",
      language: "html",
      kind: "html",
      displayName: typeof title === "string" ? title : "Design",
      typeLabel: ".os.html",
      updatedAt,
    };
    const artifact: DesignSnapshotArtifact = {
      artifactId,
      kind: "os-html",
      content: entry.doc,
      metadata: {
        path,
        ...(typeof title === "string" ? { title } : {}),
        updatedAt,
      },
    };
    savedFiles.push(file);
    savedArtifacts.push(artifact);
    snapshot = {
      ...snapshot,
      files: upsertFile(snapshot.files, file),
      artifacts: upsertArtifact(snapshot.artifacts, artifact, path),
      viewState: {
        ...snapshot.viewState,
        activeFileTab: path,
        openFiles: Array.from(new Set([...snapshot.viewState.openFiles, path])),
      },
      status: "completed",
      updatedAt,
    };
  }
  ctx.snapshots.set(input.designId, snapshot);
  saveDesignSnapshot(ctx.cwd, snapshot);
  for (const artifact of savedArtifacts) ctx.emit(notify("$/artifact", artifact));
  ctx.emit(notify("$/project-mutated", { files: savedFiles }));
  return snapshot;
}

function handleSave(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  const parsed = parseSave(params, ctx.activeDesignId ?? "");
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }
  if (!isActiveDesignScope(ctx, parsed.designId)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "designId is not open"));
    return;
  }
  const result = updateSnapshotForSave(ctx, parsed);
  if (typeof result === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, result));
    return;
  }
  const paths = parsed.entries.map((entry) => artifactPath(result, entry.path));
  ctx.send(success(id, { saved: true, designId: result.designId, path: paths[0], paths }));
}

function handleList(_params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  ctx.send(success(id, { designs: listDesigns(ctx.cwd) }));
}

export const DesignSaveCapability: DesignCapability = {
  name: "design.save",
  rpcMethod: { method: "design.save", handler: handleSave },
};

export const DesignListCapability: DesignCapability = {
  name: "design.list",
  rpcMethod: { method: "design.list", handler: handleList },
};
