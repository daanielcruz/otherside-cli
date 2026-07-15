import type { PasteReference } from "@/kernel/std/types/paste.ts";

const IMAGE_REF_RE = /\[Image #(\d+)\]/g;
const TEXT_REF_RE = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g;
const TRUNCATED_REF_RE = /\[\.\.\.Truncated text #(\d+) \+(\d+) lines\.\.\.\]/g;
const ANY_REF_RE = /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g;
const NEWLINE_RE = /\r\n|\r|\n/g;

export interface RefMatch {
  id: number;
  start: number;
  end: number;
}

function matchesFor(text: string, re: RegExp): RefMatch[] {
  const out: RefMatch[] = [];
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    out.push({ id: Number(m[1]), start, end: start + m[0].length });
  }
  return out;
}

export function imageRefMatches(text: string): RefMatch[] {
  return matchesFor(text, IMAGE_REF_RE);
}

export function textRefMatches(text: string): RefMatch[] {
  return matchesFor(text, TEXT_REF_RE);
}

export function truncatedRefMatches(text: string): RefMatch[] {
  return matchesFor(text, TRUNCATED_REF_RE);
}

export function parsePasteReferences(text: string): PasteReference[] {
  const out: PasteReference[] = [];
  for (const m of text.matchAll(ANY_REF_RE)) {
    const id = Number(m[2] ?? "0");
    if (!Number.isFinite(id) || id <= 0) continue;
    const start = m.index ?? 0;
    out.push({ id, match: m[0], start, end: start + m[0].length });
  }
  return out;
}

export function formatPasteRef(type: "text" | "image", id: number, content: string): string {
  if (type === "image") return `[Image #${id}]`;
  const lines = (content.match(NEWLINE_RE) ?? []).length;
  return lines === 0 ? `[Pasted text #${id}]` : `[Pasted text #${id} +${lines} lines]`;
}

export function formatTruncatedRef(id: number, content: string): string {
  const lines = (content.match(NEWLINE_RE) ?? []).length;
  return `[...Truncated text #${id} +${lines} lines...]`;
}
