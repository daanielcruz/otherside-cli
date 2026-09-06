import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isErrno } from "@/kernel/std/errno.ts";
import { withFileLock } from "@/kernel/std/fs/file-lock.ts";
import { canonicalizeCwd, configRoot } from "@/kernel/std/fs/paths.ts";

export const MAX_PROMPT_HISTORY_ITEMS = 100;

/**
 * How far back the reverse-incremental search reaches. It scans a wider window
 * than the arrow-key walk because it spans every project rather than one, and
 * it is bounded so a single eager read cannot grow with the whole store.
 */
export const MAX_PROMPT_SEARCH_ITEMS = 1000;

const READ_CHUNK_BYTES = 64 * 1024;
const FLUSH_DEBOUNCE_MS = 50;

interface StoredEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId?: string;
}

export function promptHistoryPath(): string {
  return join(configRoot(), "history.jsonl");
}

function parseLine(raw: string): StoredEntry | null {
  if (raw.length === 0) return null;
  try {
    const obj = JSON.parse(raw) as Partial<StoredEntry>;
    if (typeof obj.display !== "string") return null;
    if (typeof obj.project !== "string") return null;
    if (typeof obj.timestamp !== "number") return null;
    return {
      display: obj.display,
      timestamp: obj.timestamp,
      project: obj.project,
      ...(typeof obj.sessionId === "string" ? { sessionId: obj.sessionId } : {}),
    };
  } catch {
    return null;
  }
}

function* readLinesReverseSync(path: string): Generator<string> {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return;
    return;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return;
    let pos = size;
    let carry = "";
    const buf = Buffer.alloc(READ_CHUNK_BYTES);
    while (pos > 0) {
      const want = Math.min(READ_CHUNK_BYTES, pos);
      pos -= want;
      const read = readSync(fd, buf, 0, want, pos);
      if (read === 0) break;
      const chunk = buf.subarray(0, read).toString("utf8") + carry;
      const newlineIdx = chunk.indexOf("\n");
      if (pos > 0 && newlineIdx >= 0) {
        carry = chunk.slice(0, newlineIdx);
        const rest = chunk.slice(newlineIdx + 1);
        const lines = rest.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (line !== undefined && line.length > 0) yield line;
        }
      } else if (pos === 0) {
        const lines = chunk.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (line !== undefined && line.length > 0) yield line;
        }
        carry = "";
      } else {
        carry = chunk;
      }
    }
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

export function loadPromptHistoryForCwd(cwd: string, currentSessionId?: string): string[] {
  const path = promptHistoryPath();
  const canonicalCwd = canonicalizeCwd(cwd);
  const reversedCurrent: string[] = [];
  const reversedOther: string[] = [];
  for (const line of readLinesReverseSync(path)) {
    const entry = parseLine(line);
    if (entry === null) continue;
    if (canonicalizeCwd(entry.project) !== canonicalCwd) continue;
    if (skippedEntryKeys.has(entryKey(entry))) continue;
    const isCurrent = currentSessionId !== undefined && entry.sessionId === currentSessionId;
    const bucket = isCurrent ? reversedCurrent : reversedOther;
    bucket.push(entry.display);
    if (reversedCurrent.length + reversedOther.length >= MAX_PROMPT_HISTORY_ITEMS) break;
  }
  return [...reversedOther.reverse(), ...reversedCurrent.reverse()];
}

/** This session's own prompts, oldest first. */
export function loadPromptHistoryForSession(sessionId: string): string[] {
  const reversed: string[] = [];
  for (const line of readLinesReverseSync(promptHistoryPath())) {
    const entry = parseLine(line);
    if (entry === null || entry.sessionId !== sessionId) continue;
    if (skippedEntryKeys.has(entryKey(entry))) continue;
    reversed.push(entry.display);
    if (reversed.length >= MAX_PROMPT_SEARCH_ITEMS) break;
  }
  return reversed.reverse();
}

/**
 * Every stored prompt, oldest first, regardless of which project typed it. The
 * reverse-incremental search reads this rather than the current project's
 * slice, so a prompt written in another checkout stays reachable; the
 * arrow-key walk keeps the narrower per-project view.
 */
export function loadPromptHistoryAllProjects(): string[] {
  const reversed: string[] = [];
  for (const line of readLinesReverseSync(promptHistoryPath())) {
    const entry = parseLine(line);
    if (entry === null) continue;
    if (skippedEntryKeys.has(entryKey(entry))) continue;
    reversed.push(entry.display);
    if (reversed.length >= MAX_PROMPT_SEARCH_ITEMS) break;
  }
  return reversed.reverse();
}

export interface AppendPromptHistoryInput {
  display: string;
  cwd: string;
  sessionId: string;
}

let pending: StoredEntry[] = [];
let lastAddedEntry: StoredEntry | null = null;
const skippedEntryKeys = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let exitHookRegistered = false;

function entryKey(entry: StoredEntry): string {
  return `${entry.timestamp}\0${entry.sessionId ?? ""}`;
}

function registerExitFlushOnce(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on("exit", () => {
    if (pending.length === 0) return;
    try {
      const path = promptHistoryPath();
      mkdirSync(dirname(path), { recursive: true });
      const payload = pending.map((e) => `${JSON.stringify(e)}\n`).join("");
      pending = [];
      appendFileSync(path, payload, { mode: 0o600 });
    } catch {}
  });
}

async function drainPending(): Promise<void> {
  if (pending.length === 0) return;
  const path = promptHistoryPath();
  await mkdir(dirname(path), { recursive: true });
  await withFileLock(path, async () => {
    const batch = pending;
    pending = [];
    const payload = batch.map((e) => `${JSON.stringify(e)}\n`).join("");
    try {
      await appendFile(path, payload, { mode: 0o600 });
    } catch {
      pending = batch.concat(pending);
    }
  });
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (inFlight !== null) {
      void inFlight.then(scheduleFlush);
      return;
    }
    inFlight = drainPending().finally(() => {
      inFlight = null;
      if (pending.length > 0) scheduleFlush();
    });
  }, FLUSH_DEBOUNCE_MS);
}

export async function appendPromptHistory(input: AppendPromptHistoryInput): Promise<void> {
  registerExitFlushOnce();
  const entry: StoredEntry = {
    display: input.display,
    timestamp: Date.now(),
    project: canonicalizeCwd(input.cwd),
    sessionId: input.sessionId,
  };
  pending.push(entry);
  lastAddedEntry = entry;
  scheduleFlush();
}

export function removeLastPromptHistoryEntry(): void {
  if (lastAddedEntry === null) return;
  const entry = lastAddedEntry;
  lastAddedEntry = null;
  const idx = pending.lastIndexOf(entry);
  if (idx !== -1) {
    pending.splice(idx, 1);
    return;
  }
  skippedEntryKeys.add(entryKey(entry));
}

export function clearPendingPromptHistory(): void {
  pending = [];
  lastAddedEntry = null;
  skippedEntryKeys.clear();
}

export function ensurePromptHistoryRoot(): void {
  try {
    mkdirSync(dirname(promptHistoryPath()), { recursive: true });
  } catch {}
}
