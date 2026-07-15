import { notify } from "@/design/bridge/envelope.ts";
import type { DesignSnapshot, DesignSnapshotFile, RpcContext } from "@/design/types.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";

export const DESIGN_STREAM_TOOL_INPUTS: ReadonlySet<string> = new Set([
  "create_design",
  "update_design",
]);

const DEFAULT_DESIGN_PATH = "design.os.html";
const FIRST_PREVIEW_CHARS = 128;
// Keep relay capacity available for text, tool, and lifecycle events.
const PREVIEW_INTERVAL_MS = 1_500;

interface DecodedString {
  value: string;
  complete: boolean;
}

interface PartialDesignInput {
  content?: DecodedString;
  path?: DecodedString;
  artifactId?: DecodedString;
  title?: DecodedString;
}

interface PreviewEntry {
  toolName: string;
  raw: string;
  path: string | undefined;
  baseline: DesignSnapshotFile | undefined;
  pending: DesignSnapshotFile | undefined;
  lastContent: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface LocatedString extends DecodedString {
  end: number;
}

function decodeString(raw: string, start: number): LocatedString {
  let value = "";
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '"') return { value, complete: true, end: index + 1 };
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = raw[index + 1];
    if (escaped === undefined) return { value, complete: false, end: raw.length };
    index += 1;
    if (escaped === '"' || escaped === "\\" || escaped === "/") value += escaped;
    else if (escaped === "b") value += "\b";
    else if (escaped === "f") value += "\f";
    else if (escaped === "n") value += "\n";
    else if (escaped === "r") value += "\r";
    else if (escaped === "t") value += "\t";
    else if (escaped === "u") {
      const hex = raw.slice(index + 1, index + 5);
      if (hex.length < 4 || !/^[0-9a-f]{4}$/i.test(hex)) {
        return { value, complete: false, end: raw.length };
      }
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    } else {
      return { value, complete: false, end: raw.length };
    }
  }
  return { value, complete: false, end: raw.length };
}

function decodeStringField(raw: string, key: string): DecodedString | undefined {
  let depth = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      continue;
    }
    if (character !== '"') continue;
    const candidate = decodeString(raw, index + 1);
    if (!candidate.complete) return undefined;
    index = candidate.end - 1;
    if (depth !== 1 || candidate.value !== key) continue;
    let cursor = candidate.end;
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
    if (raw[cursor] !== ":") continue;
    cursor += 1;
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
    if (raw[cursor] !== '"') return undefined;
    const value = decodeString(raw, cursor + 1);
    return { value: value.value, complete: value.complete };
  }
  return undefined;
}

export function partialDesignInput(raw: string): PartialDesignInput {
  const content = decodeStringField(raw, "content");
  const path = decodeStringField(raw, "path");
  const artifactId = decodeStringField(raw, "artifactId");
  const title = decodeStringField(raw, "title");
  return {
    ...(content ? { content } : {}),
    ...(path ? { path } : {}),
    ...(artifactId ? { artifactId } : {}),
    ...(title ? { title } : {}),
  };
}

function leafName(path: string): string {
  const leaf = path.split(/[\\/]/).pop();
  return leaf && leaf.length > 0 ? leaf : path;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function isScreenPath(path: string): boolean {
  return path.endsWith(".html");
}

function nextScreenPath(snapshot: DesignSnapshot): string {
  const screens = snapshot.files.filter((file) => isScreenPath(file.path));
  if (screens.length === 0) return DEFAULT_DESIGN_PATH;
  let index = 2;
  while (screens.some((file) => file.path === `screen-${index}.os.html`)) index += 1;
  return `screen-${index}.os.html`;
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

function updateTarget(snapshot: DesignSnapshot, input: PartialDesignInput): string | undefined {
  const path = input.path?.value;
  if (path) return leafName(path);
  const artifactId = input.artifactId?.value;
  if (artifactId) {
    const artifact = snapshot.artifacts.find((entry) => entry.artifactId === artifactId);
    const artifactPath = metadataString(artifact?.metadata, "path");
    if (artifactPath) return artifactPath;
  }
  const active = snapshot.viewState.activeFileTab;
  if (active && snapshot.files.some((file) => file.path === active)) return active;
  return snapshot.files.find((file) => isScreenPath(file.path))?.path;
}

function previewFile(
  snapshot: DesignSnapshot,
  toolName: string,
  input: PartialDesignInput,
): DesignSnapshotFile | undefined {
  const content = input.content?.value;
  if (content === undefined) return undefined;
  const path =
    toolName === "create_design"
      ? input.path?.value
        ? leafName(input.path.value)
        : nextScreenPath(snapshot)
      : updateTarget(snapshot, input);
  if (!path) return undefined;
  const current = snapshot.files.find((file) => file.path === path);
  return {
    ...(current ?? {}),
    path,
    content,
    status: toolName === "create_design" ? "generated" : "modified",
    language: current?.language ?? "html",
    kind: current?.kind ?? "html",
    displayName: input.title?.value || current?.displayName || humanizeScreenName(path),
    typeLabel: current?.typeLabel ?? ".os.html",
    updatedAt: new Date().toISOString(),
  };
}

export class DesignStreamPreview {
  private readonly entries = new Map<string, PreviewEntry>();

  constructor(
    private readonly ctx: RpcContext,
    private readonly designId: string,
  ) {}

  handle(event: ForkEvent): void {
    if (event.kind === "fork_tool_input_delta") {
      this.append(event);
    } else if (event.kind === "fork_tool_dispatch_start") {
      this.flush(event.toolCallId);
    } else if (event.kind === "fork_tool_dispatch_complete") {
      if (event.isError) this.rollback(event.toolCallId);
      else this.discard(event.toolCallId);
    } else if (
      event.kind === "fork_stream_reset" ||
      event.kind === "fork_complete" ||
      event.kind === "fork_quota_exhausted"
    ) {
      this.rollbackAll();
    }
  }

  rollbackAll(): void {
    for (const toolCallId of [...this.entries.keys()]) this.rollback(toolCallId);
  }

  private append(event: Extract<ForkEvent, { kind: "fork_tool_input_delta" }>): void {
    if (!DESIGN_STREAM_TOOL_INPUTS.has(event.toolName)) return;
    const entry = this.entries.get(event.toolCallId) ?? {
      toolName: event.toolName,
      raw: "",
      path: undefined,
      baseline: undefined,
      pending: undefined,
      lastContent: undefined,
      timer: undefined,
    };
    entry.raw += event.partial;
    this.entries.set(event.toolCallId, entry);
    this.refresh(entry);
  }

  private refresh(entry: PreviewEntry): void {
    const snapshot = this.ctx.snapshots.get(this.designId);
    if (!snapshot) return;
    const input = partialDesignInput(entry.raw);
    const file = previewFile(snapshot, entry.toolName, input);
    if (!file) return;
    if (entry.path && entry.path !== file.path) this.restore(entry);
    if (entry.path !== file.path) {
      entry.path = file.path;
      entry.baseline = snapshot.files.find((candidate) => candidate.path === file.path);
      entry.lastContent = undefined;
    }
    entry.pending = file;
    const contentComplete = input.content?.complete === true;
    if (entry.lastContent === undefined) {
      if (file.content && (file.content.length >= FIRST_PREVIEW_CHARS || contentComplete)) {
        this.publish(entry);
      }
      return;
    }
    if (file.content !== entry.lastContent && !entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        this.publish(entry);
      }, PREVIEW_INTERVAL_MS);
    }
  }

  private flush(toolCallId: string): void {
    const entry = this.entries.get(toolCallId);
    if (!entry) return;
    this.refresh(entry);
    this.publish(entry);
  }

  private publish(entry: PreviewEntry): void {
    const file = entry.pending;
    if (!file || file.content === entry.lastContent) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.lastContent = file.content;
    this.ctx.emit(notify("$/project-mutated", { transient: true, files: [file] }));
  }

  private restore(entry: PreviewEntry): void {
    if (!entry.path || entry.lastContent === undefined) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (entry.baseline) {
      this.ctx.emit(notify("$/project-mutated", { transient: true, files: [entry.baseline] }));
    } else {
      this.ctx.emit(notify("$/project-mutated", { transient: true, deletedPaths: [entry.path] }));
    }
    entry.path = undefined;
    entry.baseline = undefined;
    entry.pending = undefined;
    entry.lastContent = undefined;
  }

  private rollback(toolCallId: string): void {
    const entry = this.entries.get(toolCallId);
    if (!entry) return;
    this.restore(entry);
    this.entries.delete(toolCallId);
  }

  private discard(toolCallId: string): void {
    const entry = this.entries.get(toolCallId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(toolCallId);
  }
}
