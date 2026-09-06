import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { LITE_READ_BYTES, readSessionLite } from "@/engine/session/lite.ts";
import { findSessionPath, sessionPathForCwd } from "@/engine/session/paths.ts";
import { appendRawLine } from "@/engine/session/persist.ts";

export interface SessionTitles {
  customTitle?: string;
  aiTitle?: string;
}

export function aiTitleLine(sessionId: string, aiTitle: string): string {
  return JSON.stringify({ type: "ai-title", aiTitle, sessionId });
}

export function customTitleLine(sessionId: string, customTitle: string): string {
  return JSON.stringify({ type: "custom-title", customTitle, sessionId });
}

export function isTitleLine(line: string): boolean {
  return line.startsWith('{"type":"ai-title"') || line.startsWith('{"type":"custom-title"');
}

export async function appendAiTitle(cwd: string, sessionId: string, title: string): Promise<void> {
  const path = sessionPathForCwd(cwd, sessionId);
  await appendRawLine(path, aiTitleLine(sessionId, title));
}

export async function appendCustomTitleToPath(
  path: string,
  sessionId: string,
  title: string,
): Promise<void> {
  await appendRawLine(path, customTitleLine(sessionId, title));
}

export function displayTitleFrom(titles: SessionTitles): string | undefined {
  return titles.customTitle || titles.aiTitle || undefined;
}

export async function loadSessionTitle(id: string): Promise<string | null> {
  const titles = await loadSessionTitles(id);
  if (titles === null) return null;
  return displayTitleFrom(titles) ?? null;
}

/**
 * A resumed session never re-titles: generation keys off the first real user
 * message, and a resumed conversation is already past it. The persisted title
 * (if any) is loaded for display; its absence does not reopen generation.
 * A giant session can bury its title lines beyond the bounded head/tail
 * windows — the restamp re-appends the true title near EOF (curing the file
 * for every later read) and the reread picks it up.
 */
export function seedResumedSessionTitle(
  sink: { setTitle(title: string | null): void; setAttempted(attempted: boolean): void },
  sessionId: string,
  stillCurrent: () => boolean,
): void {
  sink.setAttempted(true);
  sink.setTitle(null);
  void (async () => {
    const title = await loadSessionTitle(sessionId);
    if (!stillCurrent()) return;
    if (title !== null) {
      sink.setTitle(title);
      return;
    }
    const path = findSessionPath(sessionId);
    if (path === null) return;
    await restampSessionTitles(path);
    if (!stillCurrent()) return;
    const restamped = await loadSessionTitle(sessionId);
    if (restamped !== null && stillCurrent()) sink.setTitle(restamped);
  })();
}

/**
 * The user-assigned title only (via /rename) — never the auto-generated
 * aiTitle. Gates that treat a titled session as deliberately marked (e.g.
 * keep-worktree-on-exit) key on this, or every auto-titled session trips them.
 */
export async function loadCustomSessionTitle(id: string): Promise<string | null> {
  const titles = await loadSessionTitles(id);
  return titles?.customTitle ?? null;
}

async function loadSessionTitles(id: string): Promise<SessionTitles | null> {
  const path = findSessionPath(id);
  if (path === null) return null;
  let sizeBytes: number;
  try {
    sizeBytes = (await stat(path)).size;
  } catch {
    return null;
  }
  const lite = await readSessionLite({ path, sizeBytes, buffer: Buffer.alloc(LITE_READ_BYTES) });
  if (lite === null) return null;
  return titlesFromHeadTail(lite);
}

export function titlesFromText(raw: string): SessionTitles {
  const out: SessionTitles = {};
  const customTitle = lastJsonStringField(raw, "customTitle");
  const aiTitle = lastJsonStringField(raw, "aiTitle");
  if (customTitle !== null) out.customTitle = customTitle;
  if (aiTitle !== null) out.aiTitle = aiTitle;
  return out;
}

export function titlesFromHeadTail(slices: { head: string; tail: string }): SessionTitles {
  const headTitles = titlesFromText(slices.head);
  const tailTitles = titlesFromText(slices.tail);
  const out: SessionTitles = {};
  const customTitle = tailTitles.customTitle ?? headTitles.customTitle;
  const aiTitle = tailTitles.aiTitle ?? headTitles.aiTitle;
  if (customTitle !== undefined) out.customTitle = customTitle;
  if (aiTitle !== undefined) out.aiTitle = aiTitle;
  return out;
}

/**
 * Re-appends title lines near EOF when the bounded head/tail windows can no
 * longer see the session's true titles (a title line buried behind a record
 * larger than the head window). A user rename always re-stamps; a generated
 * title re-stamps only when no rename exists anywhere, so a stale generated
 * title can never displace a rename. Runs at durable checkpoints
 * (compaction, session exit), never on the list/read path.
 */
export async function restampSessionTitles(path: string): Promise<void> {
  let sizeBytes: number;
  try {
    sizeBytes = (await stat(path)).size;
  } catch {
    return;
  }
  if (sizeBytes <= 2 * LITE_READ_BYTES) return;
  const lite = await readSessionLite({ path, sizeBytes, buffer: Buffer.alloc(LITE_READ_BYTES) });
  if (lite === null) return;
  const visible = titlesFromHeadTail(lite);
  const truth = await scanTitlesWholeFile(path);
  const sessionId = basename(path, ".jsonl");
  if (truth.customTitle !== undefined && visible.customTitle !== truth.customTitle) {
    await appendRawLine(path, customTitleLine(sessionId, truth.customTitle));
    return;
  }
  if (
    truth.customTitle === undefined &&
    truth.aiTitle !== undefined &&
    visible.aiTitle !== truth.aiTitle
  ) {
    await appendRawLine(path, aiTitleLine(sessionId, truth.aiTitle));
  }
}

// Whole-file title scan in bounded chunks. The carry stays a Buffer so a
// chunk boundary can never split a UTF-8 sequence inside a title value;
// only complete lines are decoded and scanned.
async function scanTitlesWholeFile(path: string): Promise<SessionTitles> {
  const titles: SessionTitles = {};
  const merge = (found: SessionTitles): void => {
    if (found.customTitle !== undefined) titles.customTitle = found.customTitle;
    if (found.aiTitle !== undefined) titles.aiTitle = found.aiTitle;
  };
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let carry: Buffer = Buffer.alloc(0);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, size - position),
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      const combined = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const lastNewline = combined.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        carry = Buffer.from(combined);
        continue;
      }
      merge(titlesFromText(combined.subarray(0, lastNewline + 1).toString("utf8")));
      carry = Buffer.from(combined.subarray(lastNewline + 1));
    }
    if (carry.length > 0) merge(titlesFromText(carry.toString("utf8")));
    return titles;
  } finally {
    await handle.close();
  }
}

function lastJsonStringField(raw: string, field: string): string | null {
  const re = new RegExp(`"${field}":"((?:[^"\\\\]|\\\\.)*)"`, "g");
  let last: string | null = null;
  let match = re.exec(raw);
  while (match !== null) {
    last = match[1] ?? null;
    match = re.exec(raw);
  }
  if (last === null) return null;
  try {
    return JSON.parse(`"${last}"`) as string;
  } catch {
    return null;
  }
}
