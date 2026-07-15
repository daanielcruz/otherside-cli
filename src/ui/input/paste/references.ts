import {
  formatTruncatedRef,
  imageRefMatches,
  parsePasteReferences,
  textRefMatches,
  truncatedRefMatches,
} from "@/kernel/std/paste/ref.ts";
import type { ImageDimensions, ImageMediaType } from "@/kernel/std/types/image.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";

export const PASTE_THRESHOLD = 800;

// Programmatic buffer fills (history restore, queued sends) can exceed what
// the input area renders responsively. Above the threshold the middle of the
// text moves into the paste store behind a truncated-text reference and only
// a short head/tail preview stays editable; the reference re-expands to the
// full text on submit.
export const INPUT_TRUNCATION_THRESHOLD = 10_000;
const INPUT_PREVIEW_LENGTH = 1_000;

export function maybeTruncateBuffer(text: string, store: Pick<PasteStore, "add">): string | null {
  if (text.length <= INPUT_TRUNCATION_THRESHOLD) return null;
  const headLength = Math.floor(INPUT_PREVIEW_LENGTH / 2);
  const tailLength = Math.floor(INPUT_PREVIEW_LENGTH / 2);
  const head = text.slice(0, headLength);
  const tail = text.slice(-tailLength);
  const middle = text.slice(headLength, -tailLength);
  const { id } = store.add({ type: "text", content: middle });
  return head + formatTruncatedRef(id, middle) + tail;
}

export function refEndingAt(text: string, cursor: number): { start: number; end: number } | null {
  if (cursor <= 0) return null;
  for (const ref of parsePasteReferences(text)) {
    if (ref.end === cursor) return { start: ref.start, end: ref.end };
  }
  return null;
}

export function refStartingAt(text: string, cursor: number): { start: number; end: number } | null {
  for (const ref of parsePasteReferences(text)) {
    if (ref.start === cursor) return { start: ref.start, end: ref.end };
  }
  return null;
}

export function joinWithLeadingSpace(
  buffer: string,
  cursor: number,
  placeholder: string,
): { next: string; insertedLength: number } {
  const prev = cursor > 0 ? buffer.charAt(cursor - 1) : "";
  const needsSpace = prev.length > 0 && !/\s/.test(prev);
  const insert = needsSpace ? ` ${placeholder}` : placeholder;
  return {
    next: buffer.slice(0, cursor) + insert + buffer.slice(cursor),
    insertedLength: insert.length,
  };
}

export interface ExpandResult {
  blocks: ContentBlock[];
  text: string;
}

export function expandToContentBlocks(text: string, store: Pick<PasteStore, "get">): ExpandResult {
  const blocks: ContentBlock[] = [];
  let plainText = "";
  type Match = { kind: "image" | "text"; id: number; start: number; end: number };
  const matches: Match[] = [
    ...imageRefMatches(text).map((m) => ({ kind: "image" as const, ...m })),
    ...textRefMatches(text).map((m) => ({ kind: "text" as const, ...m })),
    ...truncatedRefMatches(text).map((m) => ({ kind: "text" as const, ...m })),
  ];
  matches.sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const match of matches) {
    const head = text.slice(cursor, match.start);
    if (head.length > 0) {
      blocks.push({ type: "text", text: head });
      plainText += head;
    }
    const stored = store.get(match.id);
    if (!stored) {
      const literal = text.slice(match.start, match.end);
      blocks.push({ type: "text", text: literal });
      plainText += literal;
    } else if (match.kind === "image" && stored.type === "image" && stored.mediaType) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: stored.mediaType as ImageMediaType,
          data: stored.content,
        },
        ...(stored.dimensions ? { dimensions: stored.dimensions as ImageDimensions } : {}),
      });
      plainText += `[Image #${match.id}]`;
    } else if (match.kind === "text" && stored.type === "text") {
      blocks.push({ type: "text", text: stored.content });
      plainText += stored.content;
    }
    cursor = match.end;
  }
  const tail = text.slice(cursor);
  if (tail.length > 0) {
    blocks.push({ type: "text", text: tail });
    plainText += tail;
  }
  if (blocks.length === 0 && text.length > 0) {
    blocks.push({ type: "text", text });
    plainText = text;
  }
  return { blocks, text: plainText };
}
