import { statSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import type { Agent } from "@/engine/queue/index.ts";
import { resetRecallStateForSession } from "@/engine/queue/runtime/prefetch.ts";
import { restoreGoalFromRecords } from "@/engine/queue/state.ts";
import { estimateHarnessTokens } from "@/engine/session/compact/harness-baseline.ts";
import { hydratePreservedImages } from "@/engine/session/compact/preserved-image-ledger.ts";
import {
  latestContextUsageSnapshotFromSessionRecords,
  resolveSessionBrokerState,
  type Session,
  type SessionBrokerState,
  type SessionMetaRecord,
  type SessionRecord,
  sessionBrokerStateKey,
  sessionPathForCwd,
} from "@/engine/session/index.ts";
import type { ToolOutputArchiveSessionRecord } from "@/engine/session/record/schema.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { replayInjectionsFromRecords } from "@/engine/session/resume.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import type { ContextUsageSnapshot } from "@/engine/session/usage/snapshot.ts";
import { restoreToolOutputArchive } from "@/engine/tool-output-archive/index.ts";
import { sanitizeMessages } from "@/engine/translator/index.ts";
import {
  effectiveOrchestrationMode,
  fastModeForProvider,
  type UserConfig,
} from "@/kernel/config/config.ts";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import type { BrokerHandle, PermissionMode } from "@/kernel/std/types/request.ts";
import type { MutableRef } from "@/kernel/std/types/state.ts";
import { restoreFilesForRewind } from "@/kernel/storage/file-history.ts";
import {
  anchorFromIndex,
  enqueueWrite,
  invalidateOffsetIndex,
  KEPT_TAIL_MAX_BYTES,
} from "./infra.ts";
import {
  collectTitleLines,
  findAnchorLine,
  readRange,
  spliceTailStreaming,
} from "./transcript/truncate.ts";

export type RewindMode = "conversation" | "code" | "both";

export interface PendingRewindPersist {
  id: string;
  mode: string;
  kept: number;
  dropped: number;
  anchorUuid: string | null;
  preservedFromByte: number;
}

export interface RewindToTranscriptIdDeps {
  session: Session;
  broker: BrokerHandle;
  agent: Agent;
  queueActions: { clear: () => void };
  getRuntimeConfig: () => UserConfig;
  setTranscript: (
    value:
      | readonly TranscriptEntry[]
      | ((prev: readonly TranscriptEntry[]) => readonly TranscriptEntry[]),
  ) => void;
  setMainLastContext: (snapshot: ContextUsageSnapshot) => void;
  setPromptText: (text: string) => void;
  pasteStoreRef: MutableRef<PasteStore>;
  suppressBrokerPersistenceRef: MutableRef<boolean>;
  persistedSessionBrokerStateRef: MutableRef<string>;
  pendingRewindPersistRef: MutableRef<PendingRewindPersist | null>;
  pendingBrokerMetaRef: MutableRef<SessionMetaRecord | null>;
  overlayStack: { closeTop: () => void };
  transcriptBatch: { flushNow: () => void };
  getTranscriptEntries: () => readonly TranscriptEntry[];
  resetRenderSurface: () => void;
  findRewindCutIndex: (
    records: SessionRecord[],
    selectedAnchor: string | undefined,
    userDroppedCount: number,
  ) => number;
  estimateTokens: (entries: readonly TranscriptEntry[], live: string) => number;
}

export type RewindToTranscriptIdFn = (id: string, mode?: RewindMode) => void;

export function createRewindToTranscriptId(deps: RewindToTranscriptIdDeps): RewindToTranscriptIdFn {
  const { session, overlayStack, getTranscriptEntries } = deps;

  return function rewindToTranscriptId(id: string, mode: RewindMode = "conversation"): void {
    const entries = getTranscriptEntries();
    const idx = entries.findIndex((entry) => entry.id === id);
    if (idx < 0) {
      overlayStack.closeTop();
      return;
    }
    const selected = entries[idx];
    if (!selected || selected.kind !== "user") {
      overlayStack.closeTop();
      return;
    }
    const droppedTurnIds = entries
      .slice(idx)
      .filter((entry) => entry.kind === "user")
      .map((entry) => entry.id);
    let skippedExternallyModified: string[] = [];
    if (mode === "code" || mode === "both") {
      ({ skippedExternallyModified } = restoreFilesForRewind(session.id, droppedTurnIds));
    }
    if (mode === "conversation" || mode === "both") {
      applyConversationRewind(deps, { id, mode, entries, idx, selected });
    } else {
      session.append("rewind", { id, mode, files: droppedTurnIds.length });
    }
    if (skippedExternallyModified.length > 0) {
      deps.setTranscript((prev) => [
        ...prev,
        {
          id: `rewind-skip-${Date.now().toString(36)}`,
          kind: "system",
          text: `restore code skipped ${skippedExternallyModified.length} file(s) modified by another session: ${skippedExternallyModified.join(", ")}`,
          isError: true,
        },
      ]);
    }
    overlayStack.closeTop();
  };
}

function applyConversationRewind(
  deps: RewindToTranscriptIdDeps,
  ctx: {
    id: string;
    mode: RewindMode;
    entries: readonly TranscriptEntry[];
    idx: number;
    selected: TranscriptEntry;
  },
): void {
  const {
    session,
    broker,
    agent,
    queueActions,
    getRuntimeConfig,
    setTranscript,
    setMainLastContext,
    setPromptText,
    pasteStoreRef,
    suppressBrokerPersistenceRef,
    persistedSessionBrokerStateRef,
    pendingRewindPersistRef,
    pendingBrokerMetaRef,
    transcriptBatch,
    resetRenderSurface,
    findRewindCutIndex,
    estimateTokens,
  } = deps;
  const { id, mode, entries, idx, selected } = ctx;

  const kept = entries.slice(0, idx);
  const userDroppedCount = entries.slice(idx).filter((entry) => entry.kind === "user").length;
  const cutAt = findRewindCutIndex(session.records, selected.anchor, userDroppedCount);
  let restoredPermissionMode: PermissionMode | null = null;
  let restoredImages: { id: number; data: string; mediaType: string }[] = [];
  const cutRecord = session.records[cutAt];
  if (cutRecord && cutRecord.type === "user_message") {
    const cutMode = cutRecord.permissionMode;
    if (
      cutMode === "default" ||
      cutMode === "accept-edits" ||
      cutMode === "plan" ||
      cutMode === "yolo"
    ) {
      restoredPermissionMode = cutMode;
    }
    if (Array.isArray(cutRecord.pastedImages)) {
      restoredImages = cutRecord.pastedImages;
    }
  }
  const keptRecords = session.records.slice(0, cutAt);
  session.records.splice(cutAt);
  if (restoredPermissionMode && broker.read().permissionMode !== restoredPermissionMode) {
    broker.dispatch({
      kind: "set_permission_mode",
      mode: restoredPermissionMode,
    });
  }
  const historicBrokerState = resolveSessionBrokerState(keptRecords, broker.read());
  restoreBrokerStateOnRewind({
    broker,
    target: historicBrokerState,
    runtimeConfig: getRuntimeConfig(),
    suppressRef: suppressBrokerPersistenceRef,
    persistedRef: persistedSessionBrokerStateRef,
  });
  agent.resetMicrocompactState();
  agent.resetSessionScopedPermissions();
  // Queued inputs and injections carry copies of messages the cut just
  // dropped; left alone they re-deliver removed content into the next turn
  // (same discipline as /clear). Injections are then re-derived from the KEPT
  // records only, mirroring resume.
  queueActions.clear();
  replayInjectionsFromRecords(session.records, agent, session.systemInjections);
  // Rebuild the active goal from the retained transcript so cutting its status
  // marker clears it while rewinding later work keeps it active.
  restoreGoalFromRecords(session.id, keptRecords);
  resetRecallStateForSession(session.id);
  pasteStoreRef.current.clear();
  const restoredPromptPrefix = restoreImagesToPromptPrefix(pasteStoreRef.current, restoredImages);
  const rebuiltMessages = sanitizeMessages(sessionRecordsToMessages(session.records));
  session.messages.splice(0, session.messages.length, ...rebuiltMessages);
  const archiveRecords = session.records
    .filter(
      (record): record is ToolOutputArchiveSessionRecord => record.type === "content_replacement",
    )
    .map((record) => ({
      kind: record.kind,
      toolUseId: record.toolUseId,
      replacement: record.replacement,
    }));
  session.toolOutputArchive = restoreToolOutputArchive(session.messages, archiveRecords);
  const rewindAnchorUuid =
    cutRecord && cutRecord.type === "user_message" && typeof cutRecord.uuid === "string"
      ? cutRecord.uuid
      : null;
  let sessionFileSize = 0;
  try {
    sessionFileSize = statSync(sessionPathForCwd(session.storageCwd, session.id)).size;
  } catch {}
  pendingRewindPersistRef.current = {
    id,
    mode,
    kept: kept.length,
    dropped: entries.length - kept.length,
    anchorUuid: rewindAnchorUuid,
    preservedFromByte: sessionFileSize,
  };
  pendingBrokerMetaRef.current = null;
  session.pendingMeta = null;
  session.chain.headUuid = null;
  applyRewindContextUsage({
    keptRecords,
    target: historicBrokerState,
    broker,
    kept,
    estimateTokens,
    setMainLastContext,
  });
  resetRenderSurface();
  setTranscript(kept);
  transcriptBatch.flushNow();
  setPromptText(`${restoredPromptPrefix}${selected.text}`);
}

export function restoreBrokerStateOnRewind(args: {
  broker: BrokerHandle;
  target: SessionBrokerState;
  runtimeConfig: UserConfig;
  suppressRef: MutableRef<boolean>;
  persistedRef: MutableRef<string>;
}): void {
  const { broker, target, runtimeConfig, suppressRef, persistedRef } = args;
  suppressRef.current = true;
  try {
    if (broker.read().provider !== target.provider) {
      broker.dispatch({
        kind: "set_route",
        route: { provider: target.provider, model: target.model },
        fastMode: target.fastMode ?? fastModeForProvider(runtimeConfig, target.provider),
      });
    } else if (broker.read().model !== target.model) {
      broker.dispatch({
        kind: "set_route",
        route: { provider: target.provider, model: target.model },
      });
    }
    if (broker.read().effort !== target.effort) {
      broker.dispatch({ kind: "set_effort", effort: target.effort });
    }
    const historicFastMode = target.fastMode ?? fastModeForProvider(runtimeConfig, target.provider);
    if (broker.read().fastMode !== historicFastMode) {
      broker.dispatch({ kind: "set_fast_mode", enabled: historicFastMode });
    }
    const desiredUltracode =
      target.ultracode !== undefined ? target.ultracode : !!runtimeConfig.ultracode;
    if (desiredUltracode) {
      broker.dispatch({
        kind: "set_ultracode",
        enabled: true,
        effort:
          target.ultracode !== undefined
            ? (target.effort ?? "high")
            : (runtimeConfig.ultracodeEffort ?? "high"),
      });
    } else if (broker.read().ultracode) {
      broker.dispatch({ kind: "set_effort", effort: target.effort });
    }
    const historicOrchestrationMode =
      target.orchestrationMode ?? effectiveOrchestrationMode(runtimeConfig);
    if (broker.read().orchestrationMode !== historicOrchestrationMode) {
      broker.dispatch({ kind: "set_orchestration_mode", mode: historicOrchestrationMode });
    }
  } finally {
    suppressRef.current = false;
    persistedRef.current = sessionBrokerStateKey(broker.read());
  }
}

function applyRewindContextUsage(args: {
  keptRecords: SessionRecord[];
  target: SessionBrokerState;
  broker: BrokerHandle;
  kept: readonly TranscriptEntry[];
  estimateTokens: (entries: readonly TranscriptEntry[], live: string) => number;
  setMainLastContext: (snapshot: ContextUsageSnapshot) => void;
}): void {
  const { keptRecords, target, broker, kept, estimateTokens, setMainLastContext } = args;
  const rewindContextUsage = latestContextUsageSnapshotFromSessionRecords(keptRecords, {
    provider: target.provider,
    model: target.model,
  });
  if (rewindContextUsage) {
    setMainLastContext({
      inputTokens: rewindContextUsage.inputTokens,
      outputTokens: rewindContextUsage.outputTokens,
      cacheReadInputTokens: rewindContextUsage.cacheReadInputTokens,
      cacheCreationInputTokens: rewindContextUsage.cacheCreationInputTokens,
    });
    return;
  }
  const rewindBroker = broker.read();
  setMainLastContext({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens:
      estimateTokens(kept, "") + estimateHarnessTokens(rewindBroker.provider, rewindBroker.model),
    cacheCreationInputTokens: 0,
  });
}

function restoreImagesToPromptPrefix(
  pasteStore: PasteStore,
  images: { id: number; data: string; mediaType: string }[],
): string {
  let prefix = "";
  for (const img of images) {
    const { placeholder } = pasteStore.add({
      type: "image",
      content: img.data,
      mediaType: img.mediaType as ImageMediaType,
    });
    prefix += `${placeholder} `;
  }
  return prefix;
}

export interface RewindTruncateRequest {
  anchorUuid: string;
  preservedFromByte: number;
}

export function truncateRewoundTail(s: Session, request: RewindTruncateRequest): Promise<boolean> {
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
      if (request.preservedFromByte > size) return false;
      const anchor =
        (await anchorFromIndex(handle, {
          path,
          anchorUuid: request.anchorUuid,
          fileSize: size,
        })) ?? (await findAnchorLine(handle, { fileSize: size, anchorUuid: request.anchorUuid }));
      if (anchor === null) return false;
      if (anchor.lineStart >= request.preservedFromByte) return false;
      invalidateOffsetIndex(path);
      const titles = await collectTitleLines(handle, {
        start: Math.min(anchor.lineEnd + 1, request.preservedFromByte),
        end: request.preservedFromByte,
      });
      const titleBlock = Buffer.from(titles.map((line) => `${line}\n`).join(""), "utf8");
      if (size - request.preservedFromByte > KEPT_TAIL_MAX_BYTES) {
        await spliceTailStreaming(handle, {
          path,
          truncateAt: anchor.lineStart,
          head: titleBlock,
          tailStart: request.preservedFromByte,
          fileSize: size,
        });
      } else {
        const appended = await readRange(handle, { start: request.preservedFromByte, end: size });
        const kept = Buffer.concat([titleBlock, appended]);
        await handle.truncate(anchor.lineStart);
        if (kept.length > 0) await handle.write(kept, 0, kept.length, anchor.lineStart);
      }
      if (s.chain.headUuid === null) s.chain.headUuid = anchor.parentUuid;
      // The truncated region may have held the only full copy of an image a
      // later mark references; rebuild the ledger from what survived.
      s.preservedImageLedger = hydratePreservedImages([s.records]);
      return true;
    } finally {
      await handle.close();
    }
  });
}
