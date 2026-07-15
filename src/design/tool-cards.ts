import { saveDesignSnapshot } from "@/design/storage.ts";
import type {
  DesignSnapshot,
  DesignSnapshotMessage,
  PersistedToolCard,
  RpcContext,
} from "@/design/types.ts";

/** Which agent produced a tool call: the main design fork or the verifier fork. */
export type ToolLane = NonNullable<PersistedToolCard["lane"]>;

// Tools whose input is large authored HTML (already persisted as artifacts) and
// never rendered in the timeline pill — their wire preview is reduced to a tiny
// { path?, title? } descriptor so the web can still label the card.
export const PREVIEWLESS_TOOLS = new Set(["create_design", "update_design"]);

// Which user-turn is currently running per design, set at turn start so tool
// cards recorded by the fork sinks carry the turn they belong to (needed to
// replay each turn's tool activity in place when rebuilding history).
const designTurnIndexes = new Map<string, number>();

export function setDesignTurnIndex(designId: string, turnIndex: number): void {
  designTurnIndexes.set(designId, turnIndex);
}

export function clearDesignTurnIndex(designId: string): void {
  designTurnIndexes.delete(designId);
}

// Per-design accumulator for the running turn's assistant text, split into
// segments at each tool-dispatch boundary. Prose the model emits before a tool
// keeps its place relative to the cards it precedes — on the live wire (each
// segment gets its own $/delta id → its own bubble) and on disk (each flushed
// segment is persisted as an assistant message stamped between the surrounding
// cards). The final segment (no tool follows it) is left to completeSnapshot.
interface TurnTextSegment {
  index: number;
  buffer: string;
}

const designTextSegments = new Map<string, TurnTextSegment>();

export function beginDesignTextSegments(designId: string): void {
  designTextSegments.set(designId, { index: 0, buffer: "" });
}

export function clearDesignTextSegments(designId: string): void {
  designTextSegments.delete(designId);
}

// The segment index the current text belongs to — the live $/delta id embeds it
// so consecutive segments render as distinct bubbles instead of merging.
export function currentDesignTextSegment(designId: string): number {
  return designTextSegments.get(designId)?.index ?? 0;
}

export function appendDesignText(designId: string, delta: string): void {
  const segment = designTextSegments.get(designId);
  if (segment) segment.buffer += delta;
}

// Called just before a tool card is recorded: the buffered text ran BEFORE this
// tool, so persist it as its own assistant message and open a fresh segment for
// any text that follows. A whitespace-only buffer (or back-to-back tools with no
// prose between) advances nothing.
export function flushDesignText(ctx: RpcContext, designId: string): void {
  const segment = designTextSegments.get(designId);
  if (!segment) return;
  const text = segment.buffer;
  segment.buffer = "";
  if (text.trim().length === 0) return;
  const index = segment.index;
  segment.index += 1;
  const snapshot = ctx.snapshots.get(designId);
  if (!snapshot) return;
  const turnIndex = designTurnIndexes.get(designId) ?? 0;
  const message: DesignSnapshotMessage = {
    id: `design-assistant-${designId}-t${turnIndex}-s${index}`,
    role: "assistant",
    content: text,
    createdAt: new Date().toISOString(),
    source: "left",
    status: "done",
    turnIndex,
    segment: index,
  };
  ctx.snapshots.set(designId, { ...snapshot, messages: [...snapshot.messages, message] });
}

// Cap for the snapshot-persisted tool input/output copies. Truncation may make
// a persisted input invalid JSON; replay then degrades that input to {}.
const TOOL_SNAPSHOT_IO_CAP = 2000;

function truncateToolIo(text: string): string {
  return text.length > TOOL_SNAPSHOT_IO_CAP ? text.slice(0, TOOL_SNAPSHOT_IO_CAP) : text;
}

// Snapshot-only structured copy of the tool input — persisted for every tool,
// including the PREVIEWLESS ones whose wire preview stays stripped.
function serializeToolInput(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  try {
    const json = JSON.stringify(input);
    return json === undefined ? undefined : truncateToolIo(json);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The wire/persisted preview for a tool's start phase. For the HTML-authoring
 * tools the authored content stays off the wire — only a tiny { path?, title? }
 * descriptor survives so the timeline can label "Designing: menu.os.html".
 * Every other tool keeps its raw input as before.
 */
export function designToolPreview(name: string, input: unknown): unknown {
  if (!PREVIEWLESS_TOOLS.has(name)) return input;
  if (!isRecord(input)) return undefined;
  const path = typeof input.path === "string" && input.path.length > 0 ? input.path : undefined;
  const title = typeof input.title === "string" && input.title.length > 0 ? input.title : undefined;
  if (path === undefined && title === undefined) return undefined;
  return { ...(path !== undefined ? { path } : {}), ...(title !== undefined ? { title } : {}) };
}

/**
 * Done-phase preview for the HTML-authoring tools, derived from the tool result
 * JSON ({ path, artifactId, bytes }). The result path is authoritative even
 * when the input omitted one (auto-named screens), so "Created <name>" can
 * always carry the screen name. Wire-safe: path only, never content.
 */
export function previewlessDonePreview(content: string | undefined): { path: string } | undefined {
  if (typeof content !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed) && typeof parsed.path === "string" && parsed.path.length > 0) {
      return { path: parsed.path };
    }
  } catch {
    // Error results are plain text — no path to surface.
  }
  return undefined;
}

function upsertToolCard(snapshot: DesignSnapshot, card: PersistedToolCard): DesignSnapshot {
  const tools = snapshot.tools ? [...snapshot.tools] : [];
  const index = tools.findIndex((tool) => tool.id === card.id);
  if (index >= 0) tools[index] = card;
  else tools.push(card);
  return { ...snapshot, tools };
}

export function recordToolStart(
  ctx: RpcContext,
  designId: string,
  id: string,
  name: string,
  input: unknown,
  lane: ToolLane,
): void {
  const snapshot = ctx.snapshots.get(designId);
  if (!snapshot) return;
  const preview = designToolPreview(name, input);
  const inputJson = serializeToolInput(input);
  ctx.snapshots.set(
    designId,
    upsertToolCard(snapshot, {
      id,
      name,
      phase: "running",
      lane,
      toolUseId: id,
      turnIndex: designTurnIndexes.get(designId) ?? 0,
      createdAt: new Date().toISOString(),
      ...(preview !== undefined ? { preview } : {}),
      ...(inputJson !== undefined ? { input: inputJson } : {}),
    }),
  );
}

// Final tool state persists the card to disk (mid-turn reloads then show completed
// tools); the input preview captured at start is preserved (merged with the
// result path for the HTML-authoring tools), and a truncated copy of the tool
// output is kept so the turn can be replayed structurally later.
export function recordToolEnd(
  ctx: RpcContext,
  designId: string,
  id: string,
  name: string,
  isError: boolean,
  output: string | undefined,
  lane: ToolLane,
): void {
  const snapshot = ctx.snapshots.get(designId);
  if (!snapshot) return;
  const existing = snapshot.tools?.find((tool) => tool.id === id);
  let preview = existing?.preview;
  if (PREVIEWLESS_TOOLS.has(name) && !isError) {
    const done = previewlessDonePreview(output);
    if (done) preview = { ...(isRecord(preview) ? preview : {}), ...done };
  }
  const next = upsertToolCard(snapshot, {
    id,
    name,
    phase: isError ? "error" : "done",
    lane: existing?.lane ?? lane,
    toolUseId: existing?.toolUseId ?? id,
    turnIndex: existing?.turnIndex ?? designTurnIndexes.get(designId) ?? 0,
    isError,
    ...(existing?.createdAt ? { createdAt: existing.createdAt } : {}),
    ...(preview !== undefined ? { preview } : {}),
    ...(existing?.input !== undefined ? { input: existing.input } : {}),
    ...(output !== undefined ? { output: truncateToolIo(output) } : {}),
  });
  ctx.snapshots.set(designId, next);
  saveDesignSnapshot(ctx.cwd, next);
}
