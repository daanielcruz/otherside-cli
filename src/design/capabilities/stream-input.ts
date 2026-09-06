import { isValidDesignId } from "@/design/storage.ts";
import type { DesignSnapshot, DesignSnapshotMessage } from "@/design/types.ts";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";

interface TextBlock {
  type: "text";
  text: string;
}

export interface LlmStreamInput {
  designId: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string | TextBlock[];
    // Optional client-supplied identity — used for stable snapshot matching
    // when present; older clients omit both and fall back to index matching.
    id?: string;
    createdAt?: string;
  }>;
  attachments?: Array<{ kind: "image"; data: string }>;
  medium?: string;
  activeSkills?: string[];
  codebase?: boolean;
  targetScreen?: string;
  mentionedElements?: Array<{ id: string; tag?: string; path?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseList<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (!parsed) return null;
    items.push(parsed);
  }
  return items;
}

function parseTextBlock(value: unknown): TextBlock | null {
  if (!isRecord(value)) return null;
  if (value.type !== "text") return null;
  if (typeof value.text !== "string") return null;
  return { type: "text", text: value.text };
}

function parseMessage(value: unknown): LlmStreamInput["messages"][number] | null {
  if (!isRecord(value)) return null;
  if (value.role !== "user" && value.role !== "assistant" && value.role !== "system") return null;
  const identity = {
    ...(typeof value.id === "string" && value.id.length > 0 ? { id: value.id } : {}),
    ...(typeof value.createdAt === "string" && value.createdAt.length > 0
      ? { createdAt: value.createdAt }
      : {}),
  };
  if (typeof value.content === "string") {
    return { role: value.role, content: value.content, ...identity };
  }
  const blocks = parseList(value.content, parseTextBlock);
  if (!blocks) return null;
  return { role: value.role, content: blocks, ...identity };
}

function parseAttachment(
  value: unknown,
): NonNullable<LlmStreamInput["attachments"]>[number] | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "image") return null;
  if (typeof value.data !== "string") return null;
  return { kind: "image", data: value.data };
}

export function parseImageDataUri(uri: string): { mediaType: ImageMediaType; data: string } | null {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/i.exec(uri);
  const mediaType = match?.[1];
  const data = match?.[2];
  if (!mediaType || !data) return null;
  return { mediaType: mediaType.toLowerCase() as ImageMediaType, data };
}

function hasClientCredential(raw: Record<string, unknown>): boolean {
  return raw.provider !== undefined || raw.model !== undefined || raw.apiKey !== undefined;
}

function parseMentionedElement(value: unknown): { id: string; tag?: string; path?: string } | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  const result: { id: string; tag?: string; path?: string } = { id: value.id };
  if (typeof value.tag === "string" && value.tag.length > 0) result.tag = value.tag;
  if (typeof value.path === "string" && value.path.length > 0) result.path = value.path;
  return result;
}

export function parseLlmStreamInput(
  params: unknown,
  fallbackDesignId: string,
): LlmStreamInput | string {
  if (!isRecord(params)) {
    return "params must be an object";
  }
  if (hasClientCredential(params)) return "provider, model, and apiKey are resolved by the CLI";
  const messages = parseList(params.messages, parseMessage);
  if (!messages || messages.length === 0) {
    return "messages must be a non-empty array";
  }
  const designId =
    typeof params.designId === "string" && params.designId.length > 0
      ? params.designId
      : fallbackDesignId;
  if (!isValidDesignId(designId)) return "designId contains unsafe characters";
  const attachments =
    params.attachments === undefined ? undefined : parseList(params.attachments, parseAttachment);
  if (attachments === null) return "attachments contain an invalid entry";
  const medium = typeof params.medium === "string" ? params.medium : undefined;
  const activeSkills = Array.isArray(params.activeSkills)
    ? params.activeSkills.filter((skill): skill is string => typeof skill === "string")
    : undefined;
  const codebase = params.codebase === true;
  const targetScreen =
    typeof params.targetScreen === "string" && params.targetScreen.length > 0
      ? params.targetScreen
      : undefined;

  let mentionedElements: Array<{ id: string; tag?: string; path?: string }> | undefined;
  if (params.mentionedElements !== undefined) {
    if (Array.isArray(params.mentionedElements)) {
      mentionedElements = [];
      for (const item of params.mentionedElements) {
        const parsedItem = parseMentionedElement(item);
        if (parsedItem) {
          mentionedElements.push(parsedItem);
        }
      }
    }
  }

  return {
    designId,
    messages,
    ...(attachments ? { attachments } : {}),
    ...(medium ? { medium } : {}),
    ...(activeSkills && activeSkills.length > 0 ? { activeSkills } : {}),
    ...(codebase ? { codebase } : {}),
    ...(targetScreen ? { targetScreen } : {}),
    ...(mentionedElements ? { mentionedElements } : {}),
  };
}

export function messageText(msg: LlmStreamInput["messages"][number]): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content.map((block) => block.text).join("");
}

export function visibleMessages(
  messages: LlmStreamInput["messages"],
): Array<{ role: string; content: string; id?: string; createdAt?: string }> {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: messageText(message),
      ...(message.id !== undefined ? { id: message.id } : {}),
      ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
    }))
    .filter((message) => message.content.trim().length > 0);
}

export function snapshotMessages(
  messages: LlmStreamInput["messages"],
  existingSnapshot?: DesignSnapshot | undefined,
): DesignSnapshotMessage[] {
  const baseTime = Date.now();
  const existing = existingSnapshot?.messages ?? [];
  const mapped = visibleMessages(messages).map((message, index): DesignSnapshotMessage => {
    const role = message.role === "assistant" ? "assistant" : "user";
    // A client-supplied id is authoritative; the index/content fallback only
    // covers older clients that send messages without identity.
    const byId = message.id !== undefined ? existing.find((m) => m.id === message.id) : undefined;
    const match =
      byId ??
      (existing[index] &&
      existing[index].role === role &&
      existing[index].content === message.content
        ? existing[index]
        : existing.find((m) => m.role === role && m.content === message.content));
    return {
      id: message.id ?? match?.id ?? `design-message-${index}`,
      role,
      content: message.content,
      // Fallback timestamps are offset by index so ordering stays strictly
      // monotonic instead of collapsing onto one shared timestamp.
      createdAt: message.createdAt ?? match?.createdAt ?? new Date(baseTime + index).toISOString(),
      source: "left" as const,
      status: "done" as const,
      // Rebuilding from the client list must not shed persisted-only fields —
      // losing turnIndex degrades that turn's replay to text-only.
      ...(match?.turnIndex !== undefined ? { turnIndex: match.turnIndex } : {}),
    };
  });
  // Interim text segments are CLI-authored and never echoed by the client, so a
  // rebuild from the client list would drop them; re-attach any not already
  // mapped and re-sort by timestamp so each keeps its place among the cards.
  const mappedIds = new Set(mapped.map((message) => message.id));
  const segments = existing.filter(
    (message) => message.segment !== undefined && !mappedIds.has(message.id),
  );
  if (segments.length === 0) return mapped;
  return [...mapped, ...segments].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
}
