import { displayTitleFrom, titlesFromHeadTail } from "@/engine/session/index.ts";
import { LITE_READ_BYTES, readSessionLite } from "@/engine/session/lite.ts";
import type { SessionCwdFilter, SessionFileStat } from "@/engine/session/paths.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import { pickerMaxHeight } from "@/ui/chrome/picker-geometry.ts";

export function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export const ENRICH_BATCH_COUNT = 50;
export const LABEL_CLIP_CHARS = 90;
export interface SessionEntryBase {
  id: string;
  path: string;
  updatedAt: number;
  sizeBytes: number;
  slugMatched: boolean;
}

export interface LiteSessionEntry extends SessionEntryBase {
  phase: "lite";
}

export interface EnrichedSessionEntry extends SessionEntryBase {
  phase: "enriched";
  title: string | null;
  preview: string;
  cwd: string | null;
  branch: string | null;
}

export type SessionEntry = LiteSessionEntry | EnrichedSessionEntry;

export interface ParsedSessionLine {
  type?: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  message?: { content?: Array<{ type?: string; text?: string }> };
  _os?: { type?: string; content?: string };
}

export function firstUserText(line: ParsedSessionLine): string | null {
  const original = line._os;
  if (original?.type === "user_message" && original.content) return original.content;
  if (line.type !== "user" || !Array.isArray(line.message?.content)) return null;
  for (const block of line.message.content) {
    if (block.type === "text" && block.text) return block.text;
  }
  return null;
}

export interface SessionHeadScan {
  cwd: string | null;
  branch: string | null;
  preview: string;
}

export function scanSessionHead(head: string): SessionHeadScan {
  let cwd: string | null = null;
  let branch: string | null = null;
  let preview: string | null = null;
  for (const line of head.split("\n")) {
    if (line.length === 0) continue;
    try {
      const obj = JSON.parse(line) as ParsedSessionLine;
      if (cwd === null && typeof obj.cwd === "string" && obj.cwd.length > 0) {
        cwd = obj.cwd;
      }
      if (branch === null && typeof obj.gitBranch === "string" && obj.gitBranch.length > 0) {
        branch = obj.gitBranch;
      }
      if (preview === null && !obj.isSidechain) {
        const userText = firstUserText(obj);
        if (userText && !userText.trimStart().startsWith("<")) preview = userText;
      }
      if (cwd !== null && branch !== null && preview !== null) break;
    } catch {}
  }
  return { cwd, branch, preview: preview ?? "<no messages>" };
}

export function liteEntryFrom(stat: SessionFileStat): LiteSessionEntry {
  return {
    phase: "lite",
    id: stat.id,
    path: stat.path,
    updatedAt: stat.mtime,
    sizeBytes: stat.sizeBytes,
    slugMatched: stat.slugMatched,
  };
}

export interface EnrichSliceInput {
  rows: SessionFileStat[];
  startIndex: number;
  filter: SessionCwdFilter;
  onFlush: (outcomes: EnrichOutcome[]) => void;
}

export interface EnrichOutcome {
  path: string;
  entry: EnrichedSessionEntry | null;
}

export const ENRICH_FIRST_FLUSH_COUNT = 8;
export const ENRICH_FLUSH_INTERVAL_MS = 50;

export async function enrichSlice(input: EnrichSliceInput): Promise<number> {
  const buffer = Buffer.alloc(LITE_READ_BYTES);
  let pending: EnrichOutcome[] = [];
  let flushed = false;
  let lastFlush = Date.now();
  let produced = 0;
  let index = input.startIndex;
  while (index < input.rows.length && produced < ENRICH_BATCH_COUNT) {
    const row = input.rows[index];
    index += 1;
    if (!row) continue;
    const entry = await enrichRow({ row, filter: input.filter, buffer });
    pending.push({ path: row.path, entry });
    if (entry !== null) produced += 1;
    const firstFlushDue = !flushed && pending.length >= ENRICH_FIRST_FLUSH_COUNT;
    if (firstFlushDue || Date.now() - lastFlush >= ENRICH_FLUSH_INTERVAL_MS) {
      input.onFlush(pending);
      pending = [];
      flushed = true;
      lastFlush = Date.now();
    }
  }
  if (pending.length > 0) input.onFlush(pending);
  return index;
}

export interface EnrichRowInput {
  row: SessionFileStat;
  filter: SessionCwdFilter;
  buffer: Buffer;
}

export async function enrichRow(input: EnrichRowInput): Promise<EnrichedSessionEntry | null> {
  const lite = await readSessionLite({
    path: input.row.path,
    sizeBytes: input.row.sizeBytes,
    buffer: input.buffer,
  });
  if (lite === null) {
    if (!input.row.slugMatched) return null;
    return enrichedEntryFrom({
      row: input.row,
      title: null,
      preview: "<unreadable>",
      cwd: null,
      branch: null,
    });
  }
  const scanned = scanSessionHead(lite.head);
  const cwdMatched = scanned.cwd !== null && input.filter.matchSet.has(scanned.cwd);
  if (!input.row.slugMatched && !cwdMatched) return null;
  const title = displayTitleFrom(titlesFromHeadTail(lite));
  return enrichedEntryFrom({
    row: input.row,
    title: title !== undefined ? clip(title, LABEL_CLIP_CHARS) : null,
    preview: clip(scanned.preview, LABEL_CLIP_CHARS),
    cwd: scanned.cwd,
    branch: scanned.branch,
  });
}

export interface EnrichedEntryFields {
  row: SessionFileStat;
  title: string | null;
  preview: string;
  cwd: string | null;
  branch: string | null;
}

export function enrichedEntryFrom(fields: EnrichedEntryFields): EnrichedSessionEntry {
  return {
    phase: "enriched",
    id: fields.row.id,
    path: fields.row.path,
    updatedAt: fields.row.mtime,
    sizeBytes: fields.row.sizeBytes,
    slugMatched: fields.row.slugMatched,
    title: fields.title,
    preview: fields.preview,
    cwd: fields.cwd,
    branch: fields.branch,
  };
}

export function mergeStatRows(prev: SessionEntry[], rows: SessionFileStat[]): SessionEntry[] {
  const byPath = new Map<string, SessionEntry>();
  for (const entry of prev) byPath.set(entry.path, entry);
  const next: SessionEntry[] = [];
  for (const row of rows) {
    const existing = byPath.get(row.path);
    if (existing) {
      if (existing.phase === "enriched") next.push(existing);
      else next.push({ ...existing, updatedAt: row.mtime, sizeBytes: row.sizeBytes });
    } else {
      next.push(liteEntryFrom(row));
    }
  }
  return next;
}

export function applyOutcomes(prev: SessionEntry[], outcomes: EnrichOutcome[]): SessionEntry[] {
  const byPath = new Map<string, EnrichedSessionEntry | null>();
  for (const outcome of outcomes) byPath.set(outcome.path, outcome.entry);
  const next: SessionEntry[] = [];
  for (const entry of prev) {
    if (!byPath.has(entry.path)) {
      next.push(entry);
      continue;
    }
    const enriched = byPath.get(entry.path);
    if (enriched) next.push(enriched);
  }
  return next;
}

export function isListedEntry(entry: SessionEntry): boolean {
  return entry.slugMatched || entry.phase === "enriched";
}

export function searchTextFor(entry: SessionEntry): string {
  if (entry.phase === "lite") return "";
  return `${entry.title ?? ""} ${entry.preview} ${entry.branch ?? ""}`;
}

export function labelFor(entry: SessionEntry): string {
  if (entry.phase === "lite") return entry.id;
  return entry.title ?? (entry.preview.length > 0 ? entry.preview : entry.id);
}

export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk} week${wk === 1 ? "" : "s"} ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon} month${mon === 1 ? "" : "s"} ago`;
  return `${Math.floor(mon / 12)} year${Math.floor(mon / 12) === 1 ? "" : "s"} ago`;
}

export const ROWS_PER_SESSION = 3;
export const RESUME_CHROME_ROWS = 10;

export function metaTextFor(entry: SessionEntry, sizeText: string, now = Date.now()): string {
  const branch = entry.phase === "enriched" ? (entry.branch ?? "HEAD") : "HEAD";
  return `${formatRelative(entry.updatedAt, now)} · ${branch} · ${sizeText}`;
}

export function resumeMaxHeight(terminalRows: number): number {
  return pickerMaxHeight(terminalRows);
}

export function visibleResumeRows(terminalRows: number): number {
  return Math.max(
    1,
    Math.floor((resumeMaxHeight(terminalRows) - RESUME_CHROME_ROWS) / ROWS_PER_SESSION),
  );
}

export interface PreviewLine {
  key: number;
  role: "user" | "assistant";
  text: string;
}

export interface PreviewState {
  id: string;
  updatedAt: number;
  lines: PreviewLine[];
  loading: boolean;
  error?: string;
}

export function previewLinesFromRecords(records: SessionRecord[]): PreviewLine[] {
  const out: PreviewLine[] = [];
  for (const record of records) {
    if (record.type === "user_message") {
      const text = record.content.trim();
      if (text.length === 0 || text.startsWith("<")) continue;
      out.push({ key: out.length, role: "user", text });
    } else if (record.type === "assistant_message") {
      const text = record.content.trim();
      if (text.length === 0) continue;
      out.push({ key: out.length, role: "assistant", text });
    }
  }
  return out;
}
