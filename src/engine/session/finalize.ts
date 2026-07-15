import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { clearScope, MAIN_TASK_SCOPE } from "@/engine/background/tasks/index.ts";
import { clearSessionState as clearCodexSessionState } from "@/engine/providers/codex/transport/state.ts";
import { closeAllSockets as closeCodexSockets } from "@/engine/providers/codex/transport/ws.ts";
import {
  enqueueWrite,
  invalidateOffsetIndex,
  offsetIndexForAppend,
  recordAppendedLine,
  releaseSessionForkChains,
} from "@/engine/session/infra.ts";
import { clearReadStateForScope, MAIN_SCOPE } from "@/engine/tools/builtins/read/state.ts";
import { clearAssembledTurn } from "@/engine/translator/assembled.ts";
import { shutdownAll as shutdownAllLspServers } from "@/kernel/lsp/client.ts";
import { closeAllClients } from "@/kernel/mcp/client/registry.ts";
import { evictFileHistoryCache } from "@/kernel/storage/file-history.ts";
import { sessionPathForCwd } from "./paths.ts";
import { appendRecord, recordsFromLines } from "./persist.ts";
import type { Session, SessionMetaRecord } from "./record/index.ts";
import { hasMessageRecords, isMessageRecord } from "./resume.ts";
import { detachSessionWorktreeHost } from "./worktree.ts";

const OBVIOUSLY_NONEMPTY_BYTES = 64 * 1024;

export function cleanupSessionHeapState(sessionId: string, cwd: string): void {
  clearReadStateForScope(MAIN_SCOPE);
  clearReadStateForScope(sessionId);
  clearAssembledTurn(sessionId);
  clearScope(MAIN_TASK_SCOPE);
  clearScope(sessionId);
  releaseSessionForkChains(sessionId);
  evictFileHistoryCache(sessionId);
  clearCodexSessionState(sessionId);
  invalidateOffsetIndex(sessionPathForCwd(cwd, sessionId));
}

export async function finalizeSession(s: Session): Promise<void> {
  try {
    const path = sessionPathForCwd(s.storageCwd, s.id);
    if (!hasMessageRecords(s)) {
      if (!fileHasMessageRecords(path)) {
        try {
          unlinkSync(path);
        } catch {}
      }
      return;
    }
    if (s.pendingMeta) {
      const lastMeta = lastSessionMeta(s);
      const isDuplicate =
        lastMeta?.type === "session_meta" &&
        lastMeta.provider === s.pendingMeta.provider &&
        lastMeta.model === s.pendingMeta.model &&
        lastMeta.effort === s.pendingMeta.effort &&
        lastMeta.fastMode === s.pendingMeta.fastMode;
      if (!isDuplicate) {
        try {
          await appendRecord(s, s.pendingMeta);
        } catch {}
      }
      s.pendingMeta = null;
    }
    const lastPrompt = lastUserPrompt(s);
    if (lastPrompt === null) return;
    if (!existsSync(dirname(path))) {
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch {
        return;
      }
    }
    const entry = { type: "last-prompt", sessionId: s.id, lastPrompt };
    const line = `${JSON.stringify(entry)}\n`;
    try {
      await enqueueWrite(path, async () => {
        const index = await offsetIndexForAppend(path);
        await appendFile(path, line, "utf8");
        recordAppendedLine(index, null, Buffer.byteLength(line, "utf8"));
      });
    } catch {}
  } finally {
    cleanupSessionHeapState(s.id, s.storageCwd);
    detachSessionWorktreeHost(s.id);
    closeCodexSockets();
    await closeAllClients();
    shutdownAllLspServers();
  }
}

function fileHasMessageRecords(path: string): boolean {
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.length > OBVIOUSLY_NONEMPTY_BYTES) return true;
    return recordsFromLines(raw.split("\n")).some(isMessageRecord);
  } catch {
    return false;
  }
}

function lastSessionMeta(s: Session): SessionMetaRecord | null {
  for (let i = s.records.length - 1; i >= 0; i -= 1) {
    const rec = s.records[i];
    if (rec?.type === "session_meta") return rec;
  }
  return null;
}

function lastUserPrompt(s: Session): string | null {
  for (let i = s.records.length - 1; i >= 0; i -= 1) {
    const rec = s.records[i];
    if (!rec) continue;
    if (rec.type !== "user_message") continue;
    if ("isSidechain" in rec && rec.isSidechain === true) continue;
    const text = rec.content.trim();
    if (text.length === 0) continue;
    return text;
  }
  return null;
}
