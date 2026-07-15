import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findSessionPath, sessionsRootForCwd } from "./paths.ts";
import type { InjectionQueuedRecord, Session } from "./record/index.ts";

const SYSTEM_INJECTIONS_FILE = "system-injections.jsonl";

export interface SystemInjectionEntry {
  ts: string;
  text: string;
  virtualIndex: number;
}

export async function appendSystemInjection(s: Session, r: InjectionQueuedRecord): Promise<void> {
  const entry: SystemInjectionEntry = {
    ts: r.ts,
    text: r.text,
    virtualIndex: s.records.length,
  };
  s.pushSystemInjection(entry);
  const path = systemInjectionPathForCwd(s.storageCwd, s.id);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export function loadSystemInjectionsForSession(
  sessionId: string,
  cwd: string,
): SystemInjectionEntry[] {
  const path = systemInjectionPathForSession(sessionId, cwd);
  try {
    return parseSystemInjectionLines(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

export function systemInjectionsAfterCompact(
  entries: readonly SystemInjectionEntry[],
  lastCompactIdx: number,
  recordCount: number,
): SystemInjectionEntry[] {
  return entries.filter(
    (entry) => entry.virtualIndex > lastCompactIdx && entry.virtualIndex <= recordCount,
  );
}

function systemInjectionPathForSession(sessionId: string, cwd: string): string {
  const sessionPath = findSessionPath(sessionId);
  if (sessionPath !== null) return join(dirname(sessionPath), sessionId, SYSTEM_INJECTIONS_FILE);
  return systemInjectionPathForCwd(cwd, sessionId);
}

function systemInjectionPathForCwd(cwd: string, sessionId: string): string {
  return join(sessionsRootForCwd(cwd), sessionId, SYSTEM_INJECTIONS_FILE);
}

function parseSystemInjectionLines(raw: string): SystemInjectionEntry[] {
  const entries: SystemInjectionEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.ts !== "string") continue;
      if (typeof parsed.text !== "string") continue;
      if (typeof parsed.virtualIndex !== "number") continue;
      entries.push({ ts: parsed.ts, text: parsed.text, virtualIndex: parsed.virtualIndex });
    } catch {}
  }
  return entries;
}
