import { type PromptInputMode, promptInputModeOf } from "@/engine/queue/turn/bash-input.ts";
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
  // Oldest-first history snapshot backing the prompt's reverse search.
  entries: () => readonly string[];
}

export function createPromptHistoryNav(deps: PromptHistoryNavDeps): PromptHistoryNav {
  const { historyRef, indexRef, sessionId } = deps;

  // The value last handed back to the prompt. When the live buffer no longer
  // matches it, the user has edited the recalled entry, so the next traversal
  // starts a fresh run rather than resuming from the abandoned index.
  const lastReturnedRef: { current: string | null } = { current: null };

  // The mode filter the active run was walked under. Values arrive from the
  // prompt in storage form, so a leading `!` means the prompt is in bash mode
  // and traversal narrows to bash entries only; a mode flip mid-run (recalling
  // a bash entry from prompt mode) restarts the run over the new view.
  const lastModeRef: { current: PromptInputMode } = { current: "prompt" };

  const exitScrubIfEdited = (currentValue: string): void => {
    if (lastReturnedRef.current !== null && currentValue !== lastReturnedRef.current) {
      indexRef.current = null;
      lastReturnedRef.current = null;
    }
  };

  // The entries visible to a run, per the mode of the prompt's current value.
  // indexRef indexes into this view for the duration of the run.
  const visibleHistory = (mode: PromptInputMode): string[] => {
    const history = historyRef.current;
    if (mode !== "bash") return history;
    return history.filter((item) => promptInputModeOf(item) === "bash");
  };

  const enterRun = (currentValue: string): string[] => {
    exitScrubIfEdited(currentValue);
    const mode = promptInputModeOf(currentValue);
    if (lastModeRef.current !== mode) {
      lastModeRef.current = mode;
      indexRef.current = null;
      lastReturnedRef.current = null;
    }
    return visibleHistory(mode);
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
    const history = enterRun(currentValue);
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
    const history = enterRun(currentValue);
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

  return { push, restorePrev, restoreNext, entries: () => historyRef.current };
}
