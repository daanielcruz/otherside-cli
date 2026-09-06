import { getActiveSessionId } from "@/engine/background/tasks/output-files.ts";
import { type PromptInputMode, promptInputModeOf } from "@/engine/queue/turn/bash-input.ts";
import type { HistoryScope } from "@/kernel/std/types/history-scope.ts";
import {
  appendPromptHistory,
  loadPromptHistoryAllProjects,
  loadPromptHistoryForCwd,
  loadPromptHistoryForSession,
  MAX_PROMPT_HISTORY_ITEMS,
  MAX_PROMPT_SEARCH_ITEMS,
} from "@/kernel/storage/prompt-history.ts";

/**
 * The prompt's history run: the loaded entries, the position a walk holds in
 * them, the draft parked when the walk began, and the mode filter that keeps a
 * shell walk among shell entries. Values come back as stored strings (mode
 * prefix included); the prompt applies them to its buffer.
 */
export class PromptHistoryRun {
  private history: string[] | null = null;
  private searchCorpus: string[] | null = null;
  private sessionId: string | null = null;
  private index: number | null = null;
  private mode: PromptInputMode = "prompt";
  private lastValue: string | null = null;
  private draft: string | null = null;

  /** Steps to the older entry, parking `current` as the draft on entry. */
  previous(current: string): string | null {
    const history = this.enterRun(current);
    const scrubbing = this.draft !== null;
    if (!scrubbing) this.draft = current;
    if (history.length === 0) {
      if (!scrubbing) this.draft = null;
      return null;
    }
    const next = this.index === null ? history.length - 1 : Math.max(0, this.index - 1);
    const value = history[next];
    if (value === undefined) return null;
    this.index = next;
    this.lastValue = value;
    return value;
  }

  /** Steps to the newer entry; past the newest, the parked draft comes back. */
  next(current: string): string | null {
    const history = this.enterRun(current);
    if (this.index === null) return null;
    const target = this.index + 1;
    if (target >= history.length) {
      this.index = null;
      this.lastValue = null;
      const draft = this.draft;
      this.draft = null;
      return draft ?? "";
    }
    const value = history[target];
    if (value === undefined) return null;
    this.index = target;
    this.lastValue = value;
    return value;
  }

  remember(stored: string): void {
    if (stored.trim().length === 0) return;
    this.history = [...this.entries().filter((entry) => entry !== stored), stored].slice(
      -MAX_PROMPT_HISTORY_ITEMS,
    );
    this.searchCorpus = [...this.searchEntries().filter((entry) => entry !== stored), stored].slice(
      -MAX_PROMPT_SEARCH_ITEMS,
    );
    const sessionId = getActiveSessionId();
    if (sessionId !== null) {
      void appendPromptHistory({ display: stored, cwd: process.cwd(), sessionId });
    }
  }

  /** This project's entries, oldest first — what the arrow-key walk steps through. */
  entries(): string[] {
    this.syncSession();
    this.history ??= loadPromptHistoryForCwd(process.cwd(), this.sessionId ?? undefined);
    return this.history;
  }

  /** The entries a search at this scope scans, oldest first. */
  searchEntries(scope: HistoryScope = "everywhere"): string[] {
    this.syncSession();
    if (scope === "session") {
      return this.sessionId === null ? [] : loadPromptHistoryForSession(this.sessionId);
    }
    if (scope === "project") return this.entries();
    this.searchCorpus ??= loadPromptHistoryAllProjects();
    return this.searchCorpus;
  }

  /** A new session drops both corpora and abandons whatever walk was in progress. */
  private syncSession(): void {
    const sessionId = getActiveSessionId();
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.history = null;
    this.searchCorpus = null;
    this.leave();
  }

  position(): { offset: number; total: number } | null {
    if (this.index === null) return null;
    const entries =
      this.mode === "bash"
        ? this.entries().filter((entry) => promptInputModeOf(entry) === "bash")
        : this.entries();
    return {
      offset: entries.length - this.index,
      total: entries.length,
    };
  }

  inRun(): boolean {
    return this.index !== null;
  }

  leave(): void {
    this.index = null;
    this.lastValue = null;
    this.draft = null;
  }

  /** An edited buffer or a mode flip abandons the walk before it continues. */
  private enterRun(current: string): string[] {
    const history = this.entries();
    if (this.lastValue !== null && current !== this.lastValue) {
      this.index = null;
      this.lastValue = null;
    }
    const mode = promptInputModeOf(current);
    if (mode !== this.mode) {
      this.mode = mode;
      this.index = null;
      this.lastValue = null;
    }
    return mode === "bash"
      ? history.filter((entry) => promptInputModeOf(entry) === "bash")
      : history;
  }
}
