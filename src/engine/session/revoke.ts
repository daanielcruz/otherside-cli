import { type FileHandle, open } from "node:fs/promises";
import {
  anchorFromIndex,
  enqueueWrite,
  invalidateOffsetIndex,
  KEPT_TAIL_MAX_BYTES,
} from "./infra.ts";
import { sessionPathForCwd } from "./paths.ts";
import { isChainParticipant, type Session } from "./record/index.ts";
import { rewriteSession } from "./rewrite.ts";
import { findAnchorLine, readRange, spliceTailStreaming } from "./transcript/truncate.ts";

export function revokeLastUnansweredUserMessage(s: Session): boolean {
  for (let i = s.records.length - 1; i >= 0; i--) {
    const rec = s.records[i];
    if (!rec) continue;
    if (rec.type === "session_meta" || rec.type === "usage" || rec.type === "hook_event") continue;
    if (rec.type === "assistant_message" && rec.content === "" && !rec.thinking) continue;
    if (rec.type === "user_message") {
      s.records.splice(i, 1);
      const lastMessage = s.messages.at(-1);
      if (
        lastMessage?.role === "user" &&
        lastMessage.content.length === 1 &&
        lastMessage.content[0]?.type === "text" &&
        lastMessage.content[0].text === rec.content
      ) {
        s.messages.pop();
      }
      const anchorUuid = typeof rec.uuid === "string" ? rec.uuid : null;
      restoreChainHeadFromRecords(s, anchorUuid);
      queueRevokePersistence(s, anchorUuid);
      return true;
    }
    return false;
  }
  return false;
}

function restoreChainHeadFromRecords(s: Session, revokedUuid: string | null): void {
  if (revokedUuid === null || s.chain.headUuid !== revokedUuid) return;
  for (let i = s.records.length - 1; i >= 0; i--) {
    const rec = s.records[i];
    if (!rec || !isChainParticipant(rec.type)) continue;
    if ("uuid" in rec && typeof rec.uuid === "string") s.chain.headUuid = rec.uuid;
    return;
  }
  s.chain.headUuid = null;
}

function queueRevokePersistence(s: Session, anchorUuid: string | null): void {
  const fallback = (): void => {
    try {
      rewriteSession(s).catch(() => {});
    } catch {}
  };
  if (anchorUuid === null) {
    fallback();
    return;
  }
  truncateRevokedRecord(s, anchorUuid).then((truncated) => {
    if (!truncated) fallback();
  }, fallback);
}

export function truncateRevokedRecord(s: Session, anchorUuid: string): Promise<boolean> {
  const path = sessionPathForCwd(s.storageCwd, s.id);
  return enqueueWrite(path, async () => {
    let handle: FileHandle;
    try {
      handle = await open(path, "r+");
    } catch {
      return false;
    }
    try {
      const { size } = await handle.stat();
      const anchor =
        (await anchorFromIndex(handle, { path, anchorUuid, fileSize: size })) ??
        (await findAnchorLine(handle, { fileSize: size, anchorUuid }));
      if (anchor === null) return false;
      invalidateOffsetIndex(path);
      const keptStart = Math.min(anchor.lineEnd + 1, size);
      if (size - keptStart > KEPT_TAIL_MAX_BYTES) {
        await spliceTailStreaming(handle, {
          path,
          truncateAt: anchor.lineStart,
          head: Buffer.alloc(0),
          tailStart: keptStart,
          fileSize: size,
          patchLine: (line) => reparentLine(line, anchorUuid, anchor.parentUuid),
        });
      } else {
        const tail = (await readRange(handle, { start: keptStart, end: size })).toString("utf8");
        const patched = Buffer.from(reparentTailLines(tail, anchorUuid, anchor.parentUuid), "utf8");
        await handle.truncate(anchor.lineStart);
        if (patched.length > 0) await handle.write(patched, 0, patched.length, anchor.lineStart);
      }
      if (s.chain.headUuid === anchorUuid) s.chain.headUuid = anchor.parentUuid;
      return true;
    } finally {
      await handle.close();
    }
  });
}

function reparentLine(line: string, revokedUuid: string, parentUuid: string | null): string {
  const needle = `"parentUuid":"${revokedUuid}"`;
  const idx = line.indexOf(needle);
  if (idx === -1) return line;
  const replacement = `"parentUuid":${parentUuid === null ? "null" : `"${parentUuid}"`}`;
  return line.slice(0, idx) + replacement + line.slice(idx + needle.length);
}

function reparentTailLines(tail: string, revokedUuid: string, parentUuid: string | null): string {
  if (!tail.includes(`"parentUuid":"${revokedUuid}"`)) return tail;
  return tail
    .split("\n")
    .map((line) => reparentLine(line, revokedUuid, parentUuid))
    .join("\n");
}
