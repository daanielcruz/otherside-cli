import { existsSync } from "node:fs";
import {
  looksLikeCommand,
  dispatch as slashDispatch,
  lookup as slashLookup,
} from "@/commands/dispatch.ts";
import { estimateHarnessTokens } from "@/engine/session/compact/harness-baseline.ts";
import { clearLastUsage } from "@/engine/session/compact/last-usage.ts";
import { roughTokenCountEstimationForMessages } from "@/engine/session/compact/token-count.ts";
import { emptyTokenTotals } from "@/engine/session/usage/provider.ts";
import { contextUsageTotal } from "@/engine/session/usage/snapshot.ts";
import { dispatch, overlayStack } from "@/store/index.ts";
import { addLiveOutputTokens, setLiveOutputTokens } from "@/store/live-tokens/index.ts";
import type { DispatchLoopDeps } from "@/ui/app/dispatch/types.ts";
import { compactDoneText } from "@/ui/app/status-text.ts";
import { isOverlayName } from "@/ui/panels/registry.tsx";

export function createHandleSlash(
  deps: DispatchLoopDeps,
  requestBackgroundResume: () => void,
): (rawText: string) => boolean {
  const {
    session,
    broker,
    agent,
    version,
    exit,
    runtimeConfig,
    mainLastContext,
    turnGuard,
    turnLifecycle,
    clearTranscript,
    applySlashResult,
    enterBtwMode,
    slashLifecycle,
    setTranscript,
    setMainTokenTotals,
    setMainLastContext,
    setProgressInputTokens,
    setProgressStartedAt,
    setConfigInitialTab,
    setLoginInitialProvider,
    showErrorPanel,
    pushQueued,
  } = deps;

  const handleSlash = (rawText: string): boolean => {
    const text = rawText.trim();
    if (!text.startsWith("/")) return false;
    const trimmed = text.slice(1).trim().split(/\s+/)[0] ?? "";
    if (trimmed === "") return false;
    const isKnown = !!slashLookup(trimmed);
    const looksLike = looksLikeCommand(trimmed);
    if (!isKnown) {
      if (!looksLike) return false;
      if (existsSync("/" + trimmed)) return false;
    }
    const isCompact = trimmed === "compact";
    // Hold the TurnGuard for the compact's whole run: without
    // this a concurrent /compact, or a real turn dispatched while one is still
    // running, races it instead of being rejected/queued. begin() returning null
    // means a turn is already live — queue the compact rather than clobber it;
    // it runs (and begins the guard itself) once that turn's finally promotes
    // the queue.
    let compactGeneration: number | null = null;
    if (isCompact) {
      compactGeneration = turnGuard.begin();
      if (compactGeneration === null) {
        pushQueued(text);
        return true;
      }
      dispatch({ type: "view/setTurnVerb", verb: "Compacting conversation" });
      turnLifecycle.beginTurn("compact", { startedAt: Date.now() });
    }
    void (async () => {
      let result: Awaited<ReturnType<typeof slashDispatch>>;
      try {
        result = await slashDispatch(text, {
          broker,
          config: runtimeConfig,
          session,
          agent,
          version,
          exit,
          lifecycle: slashLifecycle,
          clearTranscript,
          showErrorPanel,
          onCompactRetry: (attempt, maxAttempts, delayMs, reason) => {
            dispatch({
              type: "view/setRetryStatus",
              status: {
                attempt,
                maxAttempts,
                delayMs,
                startedAt: Date.now(),
                reason,
              },
            });
          },
          onCompactStart: () => {
            dispatch({
              type: "view/setTurnVerb",
              verb: "Compacting conversation",
            });
            setProgressStartedAt(Date.now());
            setLiveOutputTokens(0);
          },
          onCompactProgress: (charsDelta) => {
            addLiveOutputTokens(Math.round(charsDelta / 4));
          },
          onCompactDone: (info) => {
            dispatch({ type: "view/setRetryStatus", status: null });
            setMainTokenTotals(emptyTokenTotals());
            if (info.mode !== "failed") {
              clearLastUsage();
              const brokerNow = broker.read();
              setMainLastContext({
                inputTokens: 0,
                outputTokens: 0,
                cacheReadInputTokens:
                  roughTokenCountEstimationForMessages(session.messages) +
                  estimateHarnessTokens(brokerNow.provider, brokerNow.model),
                cacheCreationInputTokens: 0,
              });
            }
            setProgressInputTokens(0);
            setLiveOutputTokens(0);
            const text = compactDoneText(info);
            setTranscript((t) => [
              ...t,
              {
                id: `compact_done_${session.eventSeq}_${t.length}`,
                kind: "compaction",
                text,
                muted: true,
                ...(info.mode === "failed" ? { isError: true } : {}),
                ...(info.restoredFiles && info.restoredFiles.length > 0
                  ? { filesRead: info.restoredFiles }
                  : {}),
              },
            ]);
          },
          onCompactSucceeded: () => {},
          openOverlay: (name, initialTab) => {
            if (!isOverlayName(name)) return;
            if (name === "config") {
              setConfigInitialTab(
                initialTab === "details" || initialTab === "config" ? initialTab : undefined,
              );
            } else {
              setConfigInitialTab(undefined);
            }
            setLoginInitialProvider(undefined);
            overlayStack.open(name);
          },
          enterBtwMode: (question: string) => {
            enterBtwMode(question);
          },
          getServerInputTokens: () => {
            const base = contextUsageTotal(mainLastContext);
            return base > 0 ? base + mainLastContext.outputTokens : 0;
          },
        });
      } finally {
        if (isCompact) {
          // false means an Esc aborted the compact (agent.cancel() already
          // aborted the request) — no special handling needed, settle() just
          // reports whether this run still owns the guard.
          turnGuard.settle(compactGeneration!);
          turnLifecycle.endTurn("compact");
          requestBackgroundResume();
        }
      }
      await applySlashResult(result, text);
    })();
    return true;
  };

  return handleSlash;
}
