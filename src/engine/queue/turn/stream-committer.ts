import { accountFingerprint } from "@/engine/providers/_shared/account-identity.ts";
import {
  type AssistantRequestUsage,
  appendRecord,
  nowIso,
  type Session,
} from "@/engine/session/index.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { stableMarkdownLength } from "@/kernel/std/text/markdown.ts";
import { lastAssistantRequestId } from "@/kernel/std/types/message.ts";
import type { BrokerHandle } from "@/kernel/std/types/request.ts";

type SetState<T> = (value: T | ((prev: T) => T)) => void;
type BrokerState = ReturnType<BrokerHandle["read"]>;

export interface StreamCommitterDeps {
  startId: string;
  session: Session;
  turnState: BrokerState;
  setStreamingText: SetState<string>;
  setStreamingThinking: SetState<string>;
  setStreamingCommittedLen: SetState<number>;
  setTranscript: SetState<readonly TranscriptEntry[]>;
  takeRequestUsageStamp: () => AssistantRequestUsage | null;
  appendUsageOnlyAssistantRecord: (usage: AssistantRequestUsage) => Promise<void>;
  onThinkingHeadline?: (headline: string) => void;
  // Provider-gated (featureFlags.reasoningHeadlines): only summaries that use
  // the bold-headline section convention get the strip-and-promote treatment;
  // other providers' bold thinking paragraphs must pass through untouched.
  reasoningHeadlinesEnabled?: () => boolean;
}

// Codex reasoning summaries stream as sections whose first line is often a
// bare bold headline (`**Headline**`) with no body. Only a paragraph that is
// EXACTLY a bold-wrapped single line qualifies — this keeps Anthropic/Gemini
// prose thinking (no such paragraphs) passing through byte-identical below.
const THINKING_HEADLINE_RE = /^\*\*(.+)\*\*$/;

function thinkingHeadlineText(paragraph: string): string | null {
  const trimmed = paragraph.trim();
  if (trimmed.length === 0) return null;
  const match = THINKING_HEADLINE_RE.exec(trimmed);
  return match?.[1] ?? null;
}

function stripThinkingHeadlines(
  text: string,
  holdTrailingPartial = false,
): { body: string; lastHeadline: string | null } {
  const paragraphs = text.split(/\n\n+/);
  let lastHeadline: string | null = null;
  const headlineIndexes = new Set<number>();
  paragraphs.forEach((paragraph, index) => {
    const headline = thinkingHeadlineText(paragraph);
    if (headline !== null) {
      lastHeadline = headline;
      headlineIndexes.add(index);
    }
  });
  // No headline paragraphs at all: return the input untouched rather than
  // reassembling it, so prose-only thinking never risks a reformat.
  if (headlineIndexes.size === 0) return { body: text, lastHeadline: null };
  // Live-only: a still-streaming trailing paragraph that opens with ** is an
  // incomplete headline — hold it back so it never flashes before its closing
  // ** arrives. Commit paths pass holdTrailingPartial=false and keep it.
  const lastIndex = paragraphs.length - 1;
  const kept = paragraphs.filter(
    (paragraph, index) =>
      !headlineIndexes.has(index) &&
      paragraph.trim().length > 0 &&
      !(holdTrailingPartial && index === lastIndex && paragraph.trimStart().startsWith("**")),
  );
  return { body: kept.join("\n\n"), lastHeadline };
}

export interface StreamCommitter {
  addText: (text: string) => void;
  addThinking: (text: string) => void;
  setSignature: (signature: string) => void;
  setCurId: (id: string) => void;
  flushLive: () => void;
  freeze: () => void;
  reset: () => void;
  flushAssistant: (opts?: { allowEmpty?: boolean }) => Promise<TranscriptEntry[]>;
  snapshot: () => { acc: string; accThinking: string };
}

const STREAM_FLUSH_MS = 100;

export function createStreamCommitter(deps: StreamCommitterDeps): StreamCommitter {
  const {
    startId,
    session,
    turnState,
    setStreamingText,
    setStreamingThinking,
    setStreamingCommittedLen,
    setTranscript,
    takeRequestUsageStamp,
    appendUsageOnlyAssistantRecord,
    onThinkingHeadline,
    reasoningHeadlinesEnabled,
  } = deps;

  const headlinesOn = (): boolean => reasoningHeadlinesEnabled?.() === true;
  const stripHeadlines = (
    text: string,
    holdTrailingPartial = false,
  ): { body: string; lastHeadline: string | null } =>
    headlinesOn()
      ? stripThinkingHeadlines(text, holdTrailingPartial)
      : { body: text, lastHeadline: null };

  let acc = "";
  let accThinking = "";
  let accThinkingSignature = "";
  let thinkingBlockBoundaryPending = false;
  let committedStableLen = 0;
  let blockHasCommitted = false;
  let thinkingEntryCommitted = false;
  // Paragraph index up to which accThinking has already been scanned for a
  // completed headline (a paragraph followed by a "\n\n" boundary). The final,
  // possibly-still-open paragraph is re-checked at each commit point instead.
  let thinkingScannedParagraphs = 0;
  // The commit-point re-check (for a trailing headline with no boundary yet)
  // would otherwise re-fire a headline already promoted live off the same
  // block — this dedupes so callers see one event per distinct headline.
  let lastPromotedHeadline: string | null = null;
  const promoteHeadline = (headline: string): void => {
    if (!onThinkingHeadline || headline === lastPromotedHeadline) return;
    lastPromotedHeadline = headline;
    onThinkingHeadline(headline);
  };
  const promoteCompletedHeadlines = (): void => {
    if (!onThinkingHeadline || !headlinesOn()) return;
    const paragraphs = accThinking.split(/\n\n+/);
    const completeCount = paragraphs.length - 1;
    for (let i = thinkingScannedParagraphs; i < completeCount; i++) {
      const headline = thinkingHeadlineText(paragraphs[i] ?? "");
      if (headline !== null) promoteHeadline(headline);
    }
    thinkingScannedParagraphs = Math.max(thinkingScannedParagraphs, completeCount);
  };
  const streamCommitEnabled = process.env.OTHERSIDE_STREAM_COMMIT !== "0";
  let curId = startId;
  const committedIds = new Set<string>();
  let committedDupSeq = 0;
  const uniqueCommittedId = (): string => {
    if (!committedIds.has(curId)) {
      committedIds.add(curId);
      return curId;
    }
    committedDupSeq += 1;
    const id = `${curId}_d${committedDupSeq}`;
    committedIds.add(id);
    return id;
  };
  let thinkingSeq = 0;
  const nextThinkingId = (base: string): string => {
    thinkingSeq += 1;
    return `${base}_th${thinkingSeq}`;
  };
  let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let frozen = false;
  // True throttle-with-leading state: a leading publish only fires once per
  // STREAM_FLUSH_MS window (lastPublishAt gate below), and the trailing timer
  // only republishes if a delta actually arrived since that last publish —
  // otherwise a delta landing right after a trailing publish re-arms the timer
  // AND fires a redundant leading publish, doubling the paint cadence.
  let lastPublishAt = Number.NEGATIVE_INFINITY;
  let pendingSincePublish = false;
  const cancelStreamFlush = (): void => {
    if (streamFlushTimer === null) return;
    clearTimeout(streamFlushTimer);
    streamFlushTimer = null;
  };
  const freeze = (): void => {
    frozen = true;
    cancelStreamFlush();
    // Cancel drops partial thinking (only partial text is preserved by the
    // interruption path), so clear the live line to keep it from lingering.
    setStreamingThinking("");
  };
  const reset = (): void => {
    // stream_reset: the current provider attempt is void and the turn will
    // re-stream from scratch. Drop this attempt's live transcript chunks
    // (pushed by commitStableChunks) and every accumulator, otherwise the
    // re-send duplicates text/thinking in both the record and the UI.
    cancelStreamFlush();
    const stableChunkPrefix = `${curId}_sc`;
    const thinkingChunkPrefix = `${curId}_th`;
    setTranscript((t) =>
      t.filter(
        (entry) =>
          !entry.id.startsWith(stableChunkPrefix) && !entry.id.startsWith(thinkingChunkPrefix),
      ),
    );
    setStreamingText("");
    setStreamingThinking("");
    setStreamingCommittedLen(0);
    acc = "";
    accThinking = "";
    accThinkingSignature = "";
    thinkingBlockBoundaryPending = false;
    committedStableLen = 0;
    blockHasCommitted = false;
    thinkingEntryCommitted = false;
    thinkingScannedParagraphs = 0;
    lastPromotedHeadline = null;
    // The re-stream is a fresh cold start from the user's perspective too — it
    // should paint its own first delta immediately rather than inherit the
    // throttle window from the attempt that just got discarded.
    lastPublishAt = Number.NEGATIVE_INFINITY;
    pendingSincePublish = false;
  };
  const commitStableChunks = (): void => {
    if (frozen) return;
    if (!streamCommitEnabled) return;
    const stableLen = stableMarkdownLength(acc, committedStableLen);
    if (stableLen <= committedStableLen) return;
    const chunk = acc.slice(committedStableLen, stableLen);
    if (chunk.trim().length === 0) {
      committedStableLen = stableLen;
      return;
    }
    const isFirst = !blockHasCommitted;
    if (isFirst && !thinkingEntryCommitted && accThinking.trim().length > 0) {
      thinkingEntryCommitted = true;
      const { body: thinkingChunk, lastHeadline } = stripHeadlines(accThinking);
      if (lastHeadline !== null) promoteHeadline(lastHeadline);
      // Headline-only sections leave no body: commit no transcript entry.
      if (thinkingChunk.trim().length > 0) {
        const thinkingId = nextThinkingId(curId);
        setTranscript((t) => [...t, { id: thinkingId, kind: "thinking", text: thinkingChunk }]);
      }
      // Same batch as the committed entry: the live thinking line hands off to
      // the transcript entry atomically (no gap, no duplication).
      setStreamingThinking("");
    }
    const chunkId = `${curId}_sc${committedStableLen}`;
    setTranscript((t) => [
      ...t,
      {
        id: chunkId,
        kind: "assistant",
        text: chunk,
        ...(isFirst ? {} : { continuation: true }),
      },
    ]);
    committedStableLen = stableLen;
    blockHasCommitted = true;
  };
  const publishLiveStream = (): void => {
    if (frozen) return;
    commitStableChunks();
    setStreamingCommittedLen(committedStableLen);
    setStreamingText(acc);
    if (!thinkingEntryCommitted) setStreamingThinking(stripHeadlines(accThinking, true).body);
    lastPublishAt = Date.now();
    pendingSincePublish = false;
  };
  const scheduleStreamFlush = (opts: { leading?: boolean } = {}): void => {
    if (frozen) return;
    pendingSincePublish = true;
    if (streamFlushTimer !== null) return;
    if (opts.leading === true && Date.now() - lastPublishAt >= STREAM_FLUSH_MS) {
      publishLiveStream();
    }
    streamFlushTimer = setTimeout(() => {
      streamFlushTimer = null;
      if (pendingSincePublish) publishLiveStream();
    }, STREAM_FLUSH_MS);
  };
  const flushLive = (): void => {
    if (frozen) return;
    cancelStreamFlush();
    publishLiveStream();
  };
  const flushAssistantOnce = async (
    opts: { allowEmpty?: boolean } = {},
  ): Promise<TranscriptEntry[]> => {
    cancelStreamFlush();
    const hasText = acc.trim().length > 0;
    const hasThinking = accThinking.trim().length > 0;
    const usage = takeRequestUsageStamp();
    if (!hasText && !hasThinking && opts.allowEmpty !== true) {
      const signature = accThinkingSignature;
      if (signature.length > 0) {
        accThinkingSignature = "";
        const account = accountFingerprint(turnState.provider);
        const requestId = lastAssistantRequestId(session.messages);
        await appendRecord(session, {
          type: "assistant_message",
          ts: nowIso(),
          content: "",
          thinkingSignature: signature,
          ...(usage ? { usage } : {}),
          provider: turnState.provider,
          model: turnState.model,
          ...(account ? { producedAccount: account } : {}),
          ...(requestId ? { requestId } : {}),
        });
      } else if (usage) {
        await appendUsageOnlyAssistantRecord(usage);
      }
      return [];
    }
    const committedId = uniqueCommittedId();
    const committedText = acc;
    const { body: committedThinking, lastHeadline } = stripHeadlines(accThinking);
    if (lastHeadline !== null) promoteHeadline(lastHeadline);
    const committedSignature = accThinkingSignature;
    // A signature covers the thinking text exactly as streamed; persisting a
    // headline-stripped body would replay modified text under a signature that
    // no longer matches it, which the API rejects. Signed thinking persists
    // verbatim; headline stripping stays display-only (transcript entry below).
    const persistedThinking = committedSignature.length > 0 ? accThinking : committedThinking;
    const account = accountFingerprint(turnState.provider);
    const requestId = lastAssistantRequestId(session.messages);
    await appendRecord(session, {
      type: "assistant_message",
      ts: nowIso(),
      content: committedText,
      ...(hasThinking ? { thinking: persistedThinking } : {}),
      ...(committedSignature.length > 0 ? { thinkingSignature: committedSignature } : {}),
      ...(usage ? { usage } : {}),
      provider: turnState.provider,
      model: turnState.model,
      ...(account ? { producedAccount: account } : {}),
      ...(requestId ? { requestId } : {}),
    });
    const entries: TranscriptEntry[] = [];
    if (hasThinking && !thinkingEntryCommitted && committedThinking.trim().length > 0) {
      entries.push({
        id: nextThinkingId(committedId),
        kind: "thinking",
        text: committedThinking,
      });
    }
    if (hasText || opts.allowEmpty === true) {
      const tailText = streamCommitEnabled
        ? committedText.slice(committedStableLen)
        : committedText;
      entries.push({
        id: committedId,
        kind: "assistant",
        text: tailText,
        ...(blockHasCommitted ? { continuation: true } : {}),
      });
    }
    // This is the sole live-to-settled handoff. Publish under the current ID
    // before clearing live state so every caller (including repeated tool starts)
    // gets the same idempotent ordering and can only commit this accumulator once.
    if (entries.length > 0) setTranscript((t) => [...t, ...entries]);
    committedStableLen = 0;
    blockHasCommitted = false;
    thinkingEntryCommitted = false;
    thinkingScannedParagraphs = 0;
    lastPromotedHeadline = null;
    setStreamingText("");
    setStreamingThinking("");
    setStreamingCommittedLen(0);
    acc = "";
    accThinking = "";
    accThinkingSignature = "";
    thinkingBlockBoundaryPending = false;
    return entries;
  };
  // Event delivery is ordered today, but parallel tool starts may converge here;
  // coalesce overlap so the same accumulator cannot persist or publish twice.
  let assistantFlush: Promise<TranscriptEntry[]> | null = null;
  const flushAssistant = async (
    opts: { allowEmpty?: boolean } = {},
  ): Promise<TranscriptEntry[]> => {
    if (assistantFlush !== null) return assistantFlush;
    const pending = flushAssistantOnce(opts);
    assistantFlush = pending;
    try {
      return await pending;
    } finally {
      if (assistantFlush === pending) assistantFlush = null;
    }
  };

  return {
    addText: (text) => {
      acc += text;
      if (accThinking.length > 0) thinkingBlockBoundaryPending = true;
      scheduleStreamFlush({ leading: true });
    },
    addThinking: (text) => {
      // Interleaved thinking arrives as multiple wire blocks; the boundary is a
      // paragraph break, otherwise block N's tail glues onto block N+1's head.
      if (thinkingBlockBoundaryPending && accThinking.length > 0) {
        accThinking = `${accThinking.replace(/\n*$/, "")}\n\n`;
      }
      thinkingBlockBoundaryPending = false;
      accThinking += text;
      promoteCompletedHeadlines();
      scheduleStreamFlush();
    },
    setSignature: (signature) => {
      // signature_delta closes a thinking block on the wire.
      accThinkingSignature = signature;
      if (accThinking.length > 0) thinkingBlockBoundaryPending = true;
    },
    setCurId: (id) => {
      curId = id;
    },
    flushLive,
    freeze,
    reset,
    flushAssistant,
    snapshot: () => ({ acc, accThinking }),
  };
}
