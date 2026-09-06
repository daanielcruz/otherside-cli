import { randomUUID } from "node:crypto";
import { basename } from "node:path";

export const SESSION_BRANCH_PREFIX = "worktree-";

/**
 * PR reference forms accepted by `--worktree`: a pull-request URL
 * (`https://host/owner/repo/pull/123`) or a bare `#123`. Returns the PR
 * number, or null when the value is a plain worktree name.
 */
export function parsePRReference(raw: string): number | null {
  const url = raw.match(/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/i);
  if (url?.[1]) return Number.parseInt(url[1], 10);
  const short = raw.match(/^#(\d+)$/);
  if (short?.[1]) return Number.parseInt(short[1], 10);
  return null;
}

/** Companion tmux session name for a worktree launch: `<repo>_worktree-<name>`. */
export function worktreeTmuxSessionName(repoRoot: string, name: string): string {
  return `${basename(repoRoot)}_${SESSION_BRANCH_PREFIX}${flattenWorktreeName(name)}`.replace(
    /[/.]/g,
    "_",
  );
}

export function flattenWorktreeName(name: string): string {
  return name.replaceAll("/", "+");
}

export function isSessionManagedBranch(branch: string): boolean {
  return branch.startsWith(SESSION_BRANCH_PREFIX);
}

export function assertValidWorktreeSlug(name: string): void {
  if (name.length > 64) {
    throw new Error(`Invalid worktree name: must be 64 characters or fewer (got ${name.length})`);
  }
  for (const segment of name.split("/")) {
    if (segment === "." || segment === "..") {
      throw new Error(
        `Invalid worktree name "${name}": must not contain "." or ".." path segments`,
      );
    }
    if (segment.toLowerCase().replace(/\.+$/, "") === ".git") {
      throw new Error(
        `Invalid worktree name "${name}": "${segment}" is a reserved git directory name`,
      );
    }
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new Error(
        `Invalid worktree name "${name}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
      );
    }
  }
}

export function autoWorktreeName(): string {
  return `session-${randomUUID().slice(0, 8)}`;
}
