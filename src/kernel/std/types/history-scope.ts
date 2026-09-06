/**
 * How wide the prompt search looks.
 *
 * The same three the reference offers, and the reader picks: this session's own
 * prompts, this project's, or every project's. Which one is in force decides
 * what a query can find, so the chip says it.
 */

export const HISTORY_SCOPES = ["session", "project", "everywhere"] as const;

export type HistoryScope = (typeof HISTORY_SCOPES)[number];

/** The next scope in the cycle, wrapping — there is no end to walk off. */
export function nextHistoryScope(scope: HistoryScope): HistoryScope {
  const at = HISTORY_SCOPES.indexOf(scope);
  return HISTORY_SCOPES[(at + 1) % HISTORY_SCOPES.length] ?? "everywhere";
}

/** What the chip calls a scope. */
export function historyScopeLabel(scope: HistoryScope): string {
  return scope;
}
