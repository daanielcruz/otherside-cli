import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { emitDesignPush } from "@/design/push-hook.ts";
import type { DesignSnapshot, PersistedToolCard } from "@/design/types.ts";
import { configRoot, projectSlug } from "@/kernel/std/paths.ts";

const SNAPSHOT_FILE = "snapshot.json";
const ARTIFACT_FILE = "design.os.html";
const DESIGN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function stringList(value: unknown): string[] | null {
  if (!isUnknownArray(value)) return null;
  const items: string[] = [];
  for (const item of value) {
    if (!isString(item)) return null;
    items.push(item);
  }
  return items;
}

function parseList<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!isUnknownArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (!parsed) return null;
    items.push(parsed);
  }
  return items;
}

export interface DesignListEntry {
  designId: string;
  title: string;
  path: string | null;
  status: DesignSnapshot["status"];
  updatedAt: string;
}

export function designProjectDir(cwd: string): string {
  return join(configRoot(), "design", projectSlug(cwd));
}

export function isValidDesignId(value: unknown): value is string {
  return typeof value === "string" && DESIGN_ID_PATTERN.test(value);
}

export function designStorageDir(cwd: string, designId: string): string {
  if (!isValidDesignId(designId)) throw new Error("invalid designId");
  const projectDir = resolve(designProjectDir(cwd));
  const storageDir = resolve(projectDir, designId);
  const child = relative(projectDir, storageDir);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("invalid designId");
  }
  return storageDir;
}

export function saveDesignSnapshot(cwd: string, snapshot: DesignSnapshot): void {
  const dir = designStorageDir(cwd, snapshot.designId);
  mkdirSync(dir, { recursive: true });
  // Other sessions read these snapshots concurrently (ReadDesign tool); a
  // temp-write plus rename keeps them from ever observing a torn file.
  const snapshotPath = join(dir, SNAPSHOT_FILE);
  const tempPath = `${snapshotPath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(snapshot, null, 2));
  renameSync(tempPath, snapshotPath);
  const artifact = snapshot.artifacts[0];
  if (artifact) writeFileSync(join(dir, ARTIFACT_FILE), artifact.content);
  emitDesignPush(cwd, snapshot);
}

export function hasDesignSnapshotFile(cwd: string, designId: string): boolean {
  return existsSync(join(designStorageDir(cwd, designId), SNAPSHOT_FILE));
}

export function loadDesignSnapshot(cwd: string, designId: string): DesignSnapshot | null {
  const path = join(designStorageDir(cwd, designId), SNAPSHOT_FILE);
  if (!existsSync(path)) return null;
  try {
    const snapshot = parseSnapshot(JSON.parse(readFileSync(path, "utf8")));
    return snapshot?.designId === designId ? snapshot : null;
  } catch {
    return null;
  }
}

export function listDesigns(cwd: string): DesignListEntry[] {
  const root = designProjectDir(cwd);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isValidDesignId(entry.name))
    .map((entry) => loadDesignSnapshot(cwd, entry.name))
    .filter((snapshot): snapshot is DesignSnapshot => snapshot !== null)
    .map(designListEntry)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function designListEntry(snapshot: DesignSnapshot): DesignListEntry {
  const artifact = snapshot.artifacts[0];
  return {
    designId: snapshot.designId,
    title: snapshot.title ?? metadataString(artifact?.metadata, "title") ?? "Untitled design",
    path: metadataString(artifact?.metadata, "path") ?? snapshot.files[0]?.path ?? null,
    status: snapshot.status,
    updatedAt: snapshot.updatedAt,
  };
}

function parseSnapshot(value: unknown): DesignSnapshot | null {
  if (!isRecord(value)) return null;
  if (!isValidDesignId(value.designId)) return null;
  if (!isStatus(value.status)) return null;
  if (typeof value.updatedAt !== "string") return null;
  const messages = parseList(value.messages, parseMessage);
  const files = parseList(value.files, parseFile);
  const artifacts = parseList(value.artifacts, parseArtifact);
  const viewState = parseViewState(value.viewState);
  const designSystem = parseDesignSystem(value.designSystem);
  const tools = parseTools(value.tools);
  if (!messages || !files || !artifacts || !viewState || !designSystem) return null;
  if (value.provider !== undefined && typeof value.provider !== "string") return null;
  if (value.model !== undefined && typeof value.model !== "string") return null;
  if (value.effort !== undefined && value.effort !== null && typeof value.effort !== "string") {
    return null;
  }
  return {
    designId: value.designId,
    ...(typeof value.title === "string" && value.title.length > 0 ? { title: value.title } : {}),
    ...(typeof value.titleIsAuto === "boolean" ? { titleIsAuto: value.titleIsAuto } : {}),
    messages,
    files,
    artifacts,
    viewState,
    designSystem,
    ...(tools.length > 0 ? { tools } : {}),
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.effort === "string" || value.effort === null ? { effort: value.effort } : {}),
    status: value.status,
    updatedAt: value.updatedAt,
  };
}

// Lenient: absent → [], malformed entries dropped (never rejects the whole
// snapshot — tool cards are a rehydration nicety, not load-bearing state).
function parseTools(value: unknown): PersistedToolCard[] {
  if (!isUnknownArray(value)) return [];
  const tools: PersistedToolCard[] = [];
  for (const item of value) {
    const parsed = parseTool(item);
    if (parsed) tools.push(parsed);
  }
  return tools;
}

function isToolPhase(value: unknown): value is PersistedToolCard["phase"] {
  return value === "running" || value === "done" || value === "error";
}

function parseTool(value: unknown): PersistedToolCard | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string") return null;
  if (typeof value.name !== "string") return null;
  if (!isToolPhase(value.phase)) return null;
  return {
    id: value.id,
    name: value.name,
    phase: value.phase,
    ...(value.lane === "main" || value.lane === "verifier" ? { lane: value.lane } : {}),
    ...(value.preview !== undefined ? { preview: value.preview } : {}),
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.toolUseId === "string" ? { toolUseId: value.toolUseId } : {}),
    ...(typeof value.input === "string" ? { input: value.input } : {}),
    ...(typeof value.output === "string" ? { output: value.output } : {}),
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
    ...(typeof value.turnIndex === "number" ? { turnIndex: value.turnIndex } : {}),
  };
}

function parseViewState(value: unknown): DesignSnapshot["viewState"] | null {
  if (!isRecord(value)) return null;
  if (value.activeFileTab !== null && typeof value.activeFileTab !== "string") return null;
  if (value.activeChatId !== null && typeof value.activeChatId !== "string") return null;
  const openFiles = stringList(value.openFiles);
  if (!openFiles) return null;
  return {
    activeFileTab: value.activeFileTab,
    openFiles,
    activeChatId: value.activeChatId,
  };
}

function parseDesignSystem(value: unknown): DesignSnapshot["designSystem"] | null {
  if (!isRecord(value)) return null;
  if (typeof value.designSystemId !== "string") return null;
  if (typeof value.isDefault !== "boolean") return null;
  return { designSystemId: value.designSystemId, isDefault: value.isDefault };
}

function isStatus(value: unknown): value is DesignSnapshot["status"] {
  return (
    value === "idle" ||
    value === "awaiting" ||
    value === "streaming" ||
    value === "completed" ||
    value === "error"
  );
}

function isMessageRole(value: unknown): value is DesignSnapshot["messages"][number]["role"] {
  return value === "user" || value === "assistant";
}

function isMessageSource(
  value: unknown,
): value is NonNullable<DesignSnapshot["messages"][number]["source"]> {
  return value === "left" || value === "device";
}

function isMessageStatus(
  value: unknown,
): value is NonNullable<DesignSnapshot["messages"][number]["status"]> {
  return value === "streaming" || value === "done" || value === "error";
}

function isFileStatus(value: unknown): value is DesignSnapshot["files"][number]["status"] {
  return value === "generated" || value === "modified" || value === "unchanged";
}

function parseMessage(value: unknown): DesignSnapshot["messages"][number] | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string") return null;
  if (!isMessageRole(value.role)) return null;
  if (typeof value.content !== "string") return null;
  if (typeof value.createdAt !== "string") return null;
  if (value.source !== undefined && !isMessageSource(value.source)) return null;
  if (value.status !== undefined && !isMessageStatus(value.status)) return null;
  return {
    id: value.id,
    role: value.role,
    content: value.content,
    createdAt: value.createdAt,
    ...(value.source ? { source: value.source } : {}),
    ...(value.status ? { status: value.status } : {}),
    ...(typeof value.turnIndex === "number" ? { turnIndex: value.turnIndex } : {}),
  };
}

function parseFile(value: unknown): DesignSnapshot["files"][number] | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== "string") return null;
  if (!isFileStatus(value.status)) return null;
  if (typeof value.language !== "string") return null;
  if (value.content !== undefined && typeof value.content !== "string") return null;
  if (value.kind !== undefined && typeof value.kind !== "string") return null;
  if (value.displayName !== undefined && typeof value.displayName !== "string") return null;
  if (value.typeLabel !== undefined && typeof value.typeLabel !== "string") return null;
  if (value.updatedAt !== undefined && typeof value.updatedAt !== "string") return null;
  return {
    path: value.path,
    status: value.status,
    language: value.language,
    ...(typeof value.content === "string" ? { content: value.content } : {}),
    ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
    ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
    ...(typeof value.typeLabel === "string" ? { typeLabel: value.typeLabel } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}

function parseArtifact(value: unknown): DesignSnapshot["artifacts"][number] | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "os-html") return null;
  if (typeof value.artifactId !== "string") return null;
  if (typeof value.content !== "string") return null;
  if (value.metadata !== undefined && !isRecord(value.metadata)) return null;
  return {
    artifactId: value.artifactId,
    kind: "os-html",
    content: value.content,
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}
