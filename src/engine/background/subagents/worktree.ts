export { createWorktree } from "./worktree-creation.ts";
export {
  acquireResumedWorktreeLease,
  acquireWorktreeLease,
  type WorktreeLease,
} from "./worktree-lease.ts";
export { findNestedRepos } from "./worktree-nested-repos.ts";
export { setWorktreeOverlayCopyHookForTests } from "./worktree-overlay.ts";
export {
  isPathWithinRoot,
  isWriteEscapingWorktree,
  type PathPlatform,
} from "./worktree-path.ts";
export {
  pruneOrphanWorktrees,
  setWorktreeCleanupRemovalHookForTests,
  setWorktreeCleanupValidationHookForTests,
  type Worktree,
} from "./worktree-removal.ts";
