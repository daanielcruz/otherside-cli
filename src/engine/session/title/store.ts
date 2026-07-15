import { stat } from "node:fs/promises";
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
  return displayTitleFrom(titlesFromHeadTail(lite)) ?? null;
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
