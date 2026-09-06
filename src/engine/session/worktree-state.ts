/**
 * Session-scoped worktree state (EnterWorktree/ExitWorktree foundation).
 * Distinct from Agent-isolation worktrees under `otherside/agent/*`, which
 * overlay dirty files and only auto-remove pristine trees.
 */
export type SessionWorktreeState = {
  /** Directory active immediately before the first EnterWorktree call. */
  originalCwd: string;
  /** Project anchor from before any worktree relocation, retained across switches. */
  preEnterOriginalCwd?: string;
  activePath: string;
  /** User-facing worktree slug (unflattened), when this session created/reused it. */
  worktreeName?: string;
  managedBranch?: string;
  baseSha?: string;
  ownerRepoRoot?: string;
  nestedRepoRoot?: string;
  hookBased?: boolean;
  lockReason?: string;
  resumedExisting?: boolean;
  resetToFreshBase?: boolean;
  ownership: "created" | "enteredExisting";
  tmuxSession?: string;
};
