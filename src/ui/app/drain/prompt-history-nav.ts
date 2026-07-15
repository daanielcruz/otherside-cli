import { appendPromptHistory, MAX_PROMPT_HISTORY_ITEMS } from "@/kernel/storage/prompt-history.ts";
import type { HistoryRestoreResult } from "@/ui/input/prompt.tsx";

export interface PromptHistoryNavDeps {
  historyRef: { current: string[] };
  indexRef: { current: number | null };
  sessionId: string;
}

export interface PromptHistoryNav {
  push: (text: string) => void;
  restorePrev: (currentValue: string) => HistoryRestoreResult | null;
  restoreNext: (currentValue: string) => HistoryRestoreResult | null;
}

export function createPromptHistoryNav(deps: PromptHistoryNavDeps): PromptHistoryNav {
  const { historyRef, indexRef, sessionId } = deps;

  // The value last handed back to the prompt. When the live buffer no longer
  // matches it, the user has edited the recalled entry, so the next traversal
  // starts a fresh run rather than resuming from the abandoned index.
  const lastReturnedRef: { current: string | null } = { current: null };

  const exitScrubIfEdited = (currentValue: string): void => {
    if (lastReturnedRef.current !== null && currentValue !== lastReturnedRef.current) {
      indexRef.current = null;
      lastReturnedRef.current = null;
    }
  };

  const push = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const history = historyRef.current.filter((item) => item !== text);
    history.push(text);
    historyRef.current = history.slice(-MAX_PROMPT_HISTORY_ITEMS);
    indexRef.current = null;
    lastReturnedRef.current = null;
    void appendPromptHistory({ display: text, cwd: process.cwd(), sessionId });
  };

  const restorePrev = (currentValue: string): HistoryRestoreResult | null => {
    exitScrubIfEdited(currentValue);
    const history = historyRef.current;
    if (history.length === 0) return null;
    const current = indexRef.current;
    const next = current === null ? history.length - 1 : Math.max(0, current - 1);
    indexRef.current = next;
    const value = history[next];
    if (value === undefined) return null;
    lastReturnedRef.current = value;
    return { value, offset: history.length - next, total: history.length };
  };

  const restoreNext = (currentValue: string): HistoryRestoreResult | null => {
    exitScrubIfEdited(currentValue);
    const history = historyRef.current;
    const current = indexRef.current;
    if (current === null) return null;
    const next = current + 1;
    if (next >= history.length) {
      indexRef.current = null;
      lastReturnedRef.current = null;
      return { value: "", offset: 0, total: history.length };
    }
    indexRef.current = next;
    const value = history[next] ?? "";
    lastReturnedRef.current = value;
    return { value, offset: history.length - next, total: history.length };
  };

  return { push, restorePrev, restoreNext };
}
