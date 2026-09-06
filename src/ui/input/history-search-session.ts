import { type HistoryScope, nextHistoryScope } from "@/kernel/std/types/history-scope.ts";
import { setPromptSearch } from "@/store/prompt/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { isInsertable } from "@/ui/chrome/key-input.ts";
import { findHistoryMatch } from "@/ui/input/history-search.ts";
import { normalizePastedText } from "@/ui/input/paste/references.ts";

interface SearchState {
  query: string;
  failed: boolean;
  original: string;
  originalCaret: number;
  scanIndex: number | null;
  scope: HistoryScope;
}

export interface HistorySearchDeps {
  /** Newest-last history entries the query scans at the given scope. */
  entries: (scope: HistoryScope) => string[];
  /** Applies a matched (or restored) buffer with its caret. */
  applyText: (text: string, caret: number) => void;
  /** Submits whatever the buffer holds when the search accepts. */
  submit: () => void;
  /** Repaints the prompt; the search chip lives in the prompt store. */
  requestRender: () => void;
}

/**
 * Reverse-incremental history search (Ctrl+R). Owns the session state — query,
 * failure flag, the buffer to restore on dismissal, and the continuation
 * cursor — and publishes its visible slice through the prompt store. The
 * prompt component routes keys here while a session is open.
 */
export class HistorySearchSession {
  private state: SearchState | null = null;

  constructor(private readonly deps: HistorySearchDeps) {}

  isOpen(): boolean {
    return this.state !== null;
  }

  open(original: string, originalCaret: number): void {
    // Widest scope first: a search that finds nothing is worse than one that
    // finds too much, and narrowing is one press away.
    this.setState({
      query: "",
      failed: false,
      original,
      originalCaret,
      scanIndex: null,
      scope: "everywhere",
    });
  }

  close(): void {
    this.setState(null);
  }

  handleKey(key: KeyEventData): void {
    const search = this.state;
    if (search === null) return;
    if (key.ctrl && key.name === "r") {
      this.applyQuery(search.query, (search.scanIndex ?? -1) + 1);
      return;
    }
    if (key.ctrl && key.name === "c") {
      this.setState(null);
      this.deps.applyText(search.original, search.originalCaret);
      return;
    }
    if (key.name === "escape" || key.name === "tab") {
      this.setState(null);
      return;
    }
    // Widening or narrowing re-asks the same question of a different corpus, so
    // the query stays and the walk restarts from the newest match.
    if (key.ctrl && key.name === "s") {
      this.setState({ ...search, scope: nextHistoryScope(search.scope) });
      this.applyQuery(search.query, 0);
      return;
    }
    if (key.name === "return") {
      this.setState(null);
      if (search.query.length === 0) {
        this.deps.applyText(search.original, search.originalCaret);
        this.deps.submit();
      } else if (!search.failed) {
        this.deps.submit();
      }
      return;
    }
    if (key.name === "backspace" || (key.ctrl && key.name === "h")) {
      if (search.query.length === 0) {
        this.setState(null);
        this.deps.applyText(search.original, search.originalCaret);
      } else {
        this.applyQuery(search.query.slice(0, -1), 0);
      }
      return;
    }
    const input = key.sequence ?? "";
    if ((key.isPasted || (!key.ctrl && !key.meta)) && isInsertable(input)) {
      this.applyQuery(search.query + normalizePastedText(input), 0);
    }
  }

  private applyQuery(query: string, fromScanIndex: number): void {
    const search = this.state;
    if (search === null) return;
    if (query.length === 0) {
      this.setState({ ...search, query, failed: false, scanIndex: null });
      this.deps.applyText(search.original, search.originalCaret);
      return;
    }
    const match = findHistoryMatch(this.deps.entries(search.scope), query, fromScanIndex);
    if (match === null) {
      this.setState({ ...search, query, failed: true });
      return;
    }
    this.setState({ ...search, query, failed: false, scanIndex: match.scanIndex });
    this.deps.applyText(match.value, match.matchOffset);
  }

  private setState(state: SearchState | null): void {
    this.state = state;
    setPromptSearch(
      state === null ? null : { query: state.query, failed: state.failed, scope: state.scope },
    );
    this.deps.requestRender();
  }
}
