import { notify } from "@/design/bridge/envelope.ts";
import { designForkContextFor } from "@/design/fork-context.ts";
import { saveDesignSnapshot } from "@/design/storage.ts";
import {
  type DesignSnapshot,
  type DesignSnapshotArtifact,
  type DesignSnapshotFile,
  stableArtifactId,
} from "@/design/types.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface DesignWriteInput {
  content: string;
  path?: string;
  title?: string;
}

interface DesignPatchInput {
  content?: string;
  find?: string;
  replace?: string;
  path?: string;
  artifactId?: string;
  title?: string;
}

const DEFAULT_DESIGN_PATH = "design.os.html";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leafName(path: string): string {
  const leaf = path.split(/[\\/]/).pop();
  return leaf && leaf.length > 0 ? leaf : path;
}

function parseCreate(input: unknown): DesignWriteInput | string {
  if (!isRecord(input)) return "input must be an object";
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    return "content must be a non-empty string";
  }
  return {
    content: input.content,
    ...(typeof input.path === "string" && input.path.length > 0
      ? { path: leafName(input.path) }
      : {}),
    ...(typeof input.title === "string" && input.title.length > 0 ? { title: input.title } : {}),
  };
}

function parseUpdate(input: unknown): DesignPatchInput | string {
  if (!isRecord(input)) return "input must be an object";
  const content =
    typeof input.content === "string" && input.content.length > 0 ? input.content : undefined;
  const find = typeof input.find === "string" ? input.find : undefined;
  const replace = typeof input.replace === "string" ? input.replace : undefined;
  if (content === undefined && (find === undefined || replace === undefined)) {
    return "provide content or find/replace";
  }
  return {
    ...(content !== undefined ? { content } : {}),
    ...(find !== undefined ? { find } : {}),
    ...(replace !== undefined ? { replace } : {}),
    ...(typeof input.path === "string" && input.path.length > 0
      ? { path: leafName(input.path) }
      : {}),
    ...(typeof input.artifactId === "string" && input.artifactId.length > 0
      ? { artifactId: input.artifactId }
      : {}),
    ...(typeof input.title === "string" && input.title.length > 0 ? { title: input.title } : {}),
  };
}

interface DesignReadInput {
  path?: string;
  artifactId?: string;
}

function parseRead(input: unknown): DesignReadInput | string {
  if (!isRecord(input)) return "input must be an object";
  const path =
    typeof input.path === "string" && input.path.length > 0 ? leafName(input.path) : undefined;
  const artifactId =
    typeof input.artifactId === "string" && input.artifactId.length > 0
      ? input.artifactId
      : undefined;
  return { ...(path ? { path } : {}), ...(artifactId ? { artifactId } : {}) };
}

function isScreenPath(path: string): boolean {
  return path.endsWith(".html");
}

function humanizeScreenName(path: string): string {
  const stem = path.replace(/\.os\.html$/i, "").replace(/\.html$/i, "");
  const words = stem.replace(/[-_]+/g, " ").trim();
  if (words.length === 0) return "Design";
  return words
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function displayNameFor(path: string, title: string | undefined): string {
  if (typeof title === "string" && title.length > 0) return title;
  if (path === DEFAULT_DESIGN_PATH) return "Design";
  return humanizeScreenName(path);
}

function nextScreenPath(files: DesignSnapshotFile[]): string {
  const screens = files.filter((file) => isScreenPath(file.path));
  if (screens.length === 0) return DEFAULT_DESIGN_PATH;
  let index = 2;
  while (screens.some((file) => file.path === `screen-${index}.os.html`)) index += 1;
  return `screen-${index}.os.html`;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function documentForPath(snapshot: DesignSnapshot, path: string): string {
  const artifact = snapshot.artifacts.find(
    (entry) => metadataString(entry.metadata, "path") === path,
  );
  if (artifact) return artifact.content;
  return snapshot.files.find((file) => file.path === path)?.content ?? "";
}

type UpdateTarget = { ok: true; path: string } | { ok: false; error: string };

function resolveUpdateTarget(
  snapshot: DesignSnapshot,
  path: string | undefined,
  artifactId: string | undefined,
): UpdateTarget {
  if (artifactId) {
    const artifact = snapshot.artifacts.find((entry) => entry.artifactId === artifactId);
    const artifactPath = metadataString(artifact?.metadata, "path");
    if (artifactPath) return { ok: true, path: artifactPath };
    if (!path) return { ok: false, error: "no such screen; use create_design" };
  }
  if (path) {
    if (snapshot.files.some((entry) => entry.path === path)) return { ok: true, path };
    return { ok: false, error: "no such screen; use create_design" };
  }
  const active = snapshot.viewState.activeFileTab;
  if (active && snapshot.files.some((entry) => entry.path === active)) {
    return { ok: true, path: active };
  }
  const sole = snapshot.files.find((entry) => isScreenPath(entry.path));
  if (sole) return { ok: true, path: sole.path };
  return { ok: false, error: "no screen to update; use create_design" };
}

function upsertFile(files: DesignSnapshotFile[], file: DesignSnapshotFile): DesignSnapshotFile[] {
  const index = files.findIndex((entry) => entry.path === file.path);
  if (index === -1) return [...files, file];
  return files.map((entry, current) => (current === index ? file : entry));
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

function writeSnapshot(
  ctx: RequestContext,
  content: string,
  options: { path: string; title?: string | undefined; mode: "create" | "update" },
):
  | { ok: true; snapshot: DesignSnapshot; path: string; artifactId: string }
  | { ok: false; error: string } {
  const fork = designForkContextFor(ctx);
  if (!fork) return { ok: false, error: "design fork context is unavailable" };
  const snapshot = fork.snapshots.get(fork.designId);
  if (!snapshot) return { ok: false, error: "design snapshot is unavailable" };
  const path = options.path;
  if (options.mode === "create" && snapshot.files.some((file) => file.path === path)) {
    return { ok: false, error: "screen exists; use update_design" };
  }
  const updatedAt = new Date().toISOString();
  const artifactId = stableArtifactId(fork.designId, path);
  const existing = snapshot.artifacts.find(
    (entry) => entry.artifactId === artifactId || metadataString(entry.metadata, "path") === path,
  );
  const title = options.title ?? metadataString(existing?.metadata, "title");
  const displayName = displayNameFor(path, title);
  const file: DesignSnapshotFile = {
    path,
    content,
    status: options.mode === "create" ? "generated" : "modified",
    language: "html",
    kind: "html",
    displayName,
    typeLabel: ".os.html",
    updatedAt,
  };
  const artifact: DesignSnapshotArtifact = {
    artifactId,
    kind: "os-html",
    content,
    metadata: { path, title: displayName, updatedAt },
  };
  const next: DesignSnapshot = {
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
  fork.snapshots.set(fork.designId, next);
  saveDesignSnapshot(fork.cwd, next);
  fork.emit(
    notify("$/artifact", {
      artifactId,
      kind: "os-html",
      content,
      metadata: { path, title: displayName, updatedAt },
    }),
  );
  fork.emit(notify("$/project-mutated", { files: [file] }));
  return { ok: true, snapshot: next, path, artifactId };
}

async function runCreate(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
  const parsed = parseCreate(call.input);
  if (typeof parsed === "string") return { tool_use_id: call.id, content: parsed, is_error: true };
  const fork = designForkContextFor(ctx);
  const snapshot = fork?.snapshots.get(fork.designId);
  if (!fork || !snapshot) {
    return { tool_use_id: call.id, content: "design snapshot is unavailable", is_error: true };
  }
  const path = parsed.path ?? nextScreenPath(snapshot.files);
  const result = writeSnapshot(ctx, parsed.content, { path, title: parsed.title, mode: "create" });
  if (!result.ok) return { tool_use_id: call.id, content: result.error, is_error: true };
  return {
    tool_use_id: call.id,
    content: JSON.stringify({
      path: result.path,
      artifactId: result.artifactId,
      bytes: parsed.content.length,
    }),
  };
}

export function applyEdit(
  base: string,
  path: string,
  parsed: DesignPatchInput,
): { content: string } | string {
  if (parsed.content !== undefined) return { content: parsed.content };
  const find = parsed.find ?? "";
  if (find.length === 0) return "find must be a non-empty string";
  const segments = base.split(find);
  const matches = segments.length - 1;
  if (matches === 0) {
    return `find string not found in ${path}; call read_design to fetch the current source and copy an exact snippet`;
  }
  if (matches > 1) {
    return `find string matches ${matches} times in ${path}; extend it to a snippet that appears exactly once`;
  }
  return { content: segments.join(parsed.replace ?? "") };
}

async function runUpdate(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
  const parsed = parseUpdate(call.input);
  if (typeof parsed === "string") return { tool_use_id: call.id, content: parsed, is_error: true };
  const fork = designForkContextFor(ctx);
  const snapshot = fork?.snapshots.get(fork.designId);
  if (!fork || !snapshot) {
    return { tool_use_id: call.id, content: "design snapshot is unavailable", is_error: true };
  }
  const target = resolveUpdateTarget(snapshot, parsed.path, parsed.artifactId);
  if (!target.ok) {
    return { tool_use_id: call.id, content: target.error, is_error: true };
  }
  const base = documentForPath(snapshot, target.path);
  const edit = applyEdit(base, target.path, parsed);
  if (typeof edit === "string") {
    return { tool_use_id: call.id, content: edit, is_error: true };
  }
  const content = edit.content;
  const result = writeSnapshot(ctx, content, {
    path: target.path,
    title: parsed.title,
    mode: "update",
  });
  if (!result.ok) return { tool_use_id: call.id, content: result.error, is_error: true };
  return {
    tool_use_id: call.id,
    content: JSON.stringify({
      path: result.path,
      artifactId: result.artifactId,
      bytes: content.length,
    }),
  };
}

async function runRead(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
  const parsed = parseRead(call.input);
  if (typeof parsed === "string") return { tool_use_id: call.id, content: parsed, is_error: true };
  const fork = designForkContextFor(ctx);
  const snapshot = fork?.snapshots.get(fork.designId);
  if (!fork || !snapshot) {
    return { tool_use_id: call.id, content: "design snapshot is unavailable", is_error: true };
  }
  const target = resolveUpdateTarget(snapshot, parsed.path, parsed.artifactId);
  if (!target.ok) return { tool_use_id: call.id, content: target.error, is_error: true };
  const content = documentForPath(snapshot, target.path);
  return {
    tool_use_id: call.id,
    content: JSON.stringify({ path: target.path, bytes: content.length, content }),
  };
}

export const CreateDesignTool: ToolHandler = {
  schema: {
    name: "create_design",
    description:
      "Add a NEW screen to the canvas as a self-contained .os.html document (own path); omit path to auto-name. Use update_design to edit an existing screen.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  isConcurrencySafe: false,
  run: runCreate,
};

export const UpdateDesignTool: ToolHandler = {
  schema: {
    name: "update_design",
    description:
      "Edit an existing screen (targeted by path or artifactId) with full content or a find/replace edit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        artifactId: { type: "string" },
        title: { type: "string" },
        find: { type: "string" },
        replace: { type: "string" },
        content: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  isConcurrencySafe: false,
  run: runUpdate,
};

export const ReadDesignTool: ToolHandler = {
  schema: {
    name: "read_design",
    description:
      "Read the current source of an existing screen (by path or artifactId; omit to read the active screen) before editing it. Base every update_design find/replace on this real source, not on remembered content.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        artifactId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  isConcurrencySafe: true,
  run: runRead,
};
