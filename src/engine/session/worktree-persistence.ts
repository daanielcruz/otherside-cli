import { resolve } from "node:path";
import {
  type ActiveWorktreeSessionEntry,
  loadConfigSync,
  projectConfigKey,
  updateConfig,
} from "@/kernel/config/config.ts";
import type { SessionRecord } from "./record/schema.ts";
import type { Session } from "./record/state.ts";
import { canonicalGitRoot } from "./worktree-git.ts";
import { pathExists } from "./worktree-path.ts";
import {
  attachSessionWorktreeHost,
  latchWorktreeName,
  sessionWorktreeHost,
  settleFailedRestoreHome,
} from "./worktree-runtime.ts";
import type { SessionWorktreeState } from "./worktree-state.ts";

/**
 * On resume: restore the recorded worktree by state alone — the directory's
 * existence is the only gate, and no git process runs. A missing directory
 * clears the recorded state (stamp + slot) and the session stays at its
 * storage home (re-homed when that died with the worktree), with a
 * non-destructive warning.
 */
export async function restoreSessionWorktreeOnResume(
  session: Session,
  recorded: SessionWorktreeState | null | undefined,
): Promise<{ restored: boolean; warning?: string }> {
  attachSessionWorktreeHost(session);
  if (recorded === null || recorded === undefined) {
    session.worktree = null;
    session.cwd = session.storageCwd;
    return { restored: false };
  }

  const active = resolve(recorded.activePath);
  if (!(await pathExists(active))) {
    const home = await settleFailedRestoreHome(session, recorded);
    await clearProjectWorktreeSlot(session.id);
    return {
      restored: false,
      warning: `session worktree: ${active} no longer exists; staying at ${home}`,
    };
  }

  session.worktree = {
    ...recorded,
    activePath: active,
    originalCwd: recorded.originalCwd || session.storageCwd,
  };
  session.cwd = active;
  latchWorktreeName(session.worktree);
  // Re-persist (stamp + slot): the restored state is re-recorded as current.
  await persistProjectWorktreeSlot(session.worktree, session.id);
  return { restored: true };
}

/**
 * Latest worktree stamp in a loaded transcript, scanned from the tail.
 * `stamped: false` means the transcript predates stamps (callers fall back to
 * the project-config slot); a `state: null` stamp is an explicit exit.
 */
export function stampedWorktreeStateFrom(
  records: readonly SessionRecord[],
): { stamped: true; state: SessionWorktreeState | null } | { stamped: false } {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record?.type !== "worktree_state") continue;
    return { stamped: true, state: worktreeStateFromUnknown(record.state) };
  }
  return { stamped: false };
}

// ── project-config persistence ────────────────────────────────────────────
//
// The active worktree session is persisted as a single slot on the project
// entry of the user config (`projects[<repo root>].activeWorktreeSession`),
// written when a session enters a worktree, cleared when it exits, and read
// back on resume. The transcript itself carries no worktree state.

/** Project anchor for the slot: the repository root, else the original cwd. */
async function projectAnchorFor(state: SessionWorktreeState): Promise<string> {
  if (state.ownerRepoRoot !== undefined) return state.ownerRepoRoot;
  const root = await canonicalGitRoot(state.preEnterOriginalCwd ?? state.originalCwd);
  return root ?? resolve(state.preEnterOriginalCwd ?? state.originalCwd);
}

function slotFromState(state: SessionWorktreeState, sessionId: string): ActiveWorktreeSessionEntry {
  return { sessionId, ...state };
}

/**
 * Runtime shape gate for worktree state read back from persisted sources
 * (transcript stamp, project-config slot) — both are external inputs on
 * resume, so one validator owns the contract.
 */
function worktreeStateFromUnknown(value: unknown): SessionWorktreeState | null {
  if (value === null || typeof value !== "object") return null;
  const state = value as Record<string, unknown>;
  if (typeof state.activePath !== "string" || state.activePath.length === 0) return null;
  if (typeof state.originalCwd !== "string" || state.originalCwd.length === 0) return null;
  if (state.ownership !== "created" && state.ownership !== "enteredExisting") return null;
  return state as unknown as SessionWorktreeState;
}

function stateFromSlot(slot: ActiveWorktreeSessionEntry): SessionWorktreeState | null {
  const { sessionId: _sessionId, ...state } = slot;
  return worktreeStateFromUnknown(state);
}

/**
 * Transcript stamp for the session's current worktree state (best-effort):
 * every persisted state change is also recorded in the transcript, and the
 * latest stamp is what resume restores from.
 */
async function stampWorktreeState(
  sessionId: string,
  state: SessionWorktreeState | null,
): Promise<void> {
  const host = sessionWorktreeHost(sessionId);
  if (host === undefined) return;
  try {
    const { appendRecord } = await import("./append.ts");
    const { nowIso } = await import("./record/schema.ts");
    await appendRecord(host, {
      type: "worktree_state",
      ts: nowIso(),
      sessionId,
      state: state === null ? null : ({ ...state } as unknown as Record<string, unknown>),
    });
  } catch {
    // Best-effort: an unwritable transcript must not break worktree flow.
  }
}

/** Persist the active worktree state (transcript stamp + project slot). */
export async function persistProjectWorktreeSlot(
  state: SessionWorktreeState,
  sessionId: string,
): Promise<void> {
  await stampWorktreeState(sessionId, state);
  const key = projectConfigKey(await projectAnchorFor(state));
  try {
    await updateConfig((cfg) => {
      cfg.projects ??= {};
      // A session holds at most one slot; drop stale slots under other keys.
      for (const [existingKey, entry] of Object.entries(cfg.projects)) {
        if (existingKey !== key && entry?.activeWorktreeSession?.sessionId === sessionId) {
          delete entry.activeWorktreeSession;
        }
      }
      cfg.projects[key] = {
        ...cfg.projects[key],
        activeWorktreeSession: slotFromState(state, sessionId),
      };
    });
  } catch {
    // Best-effort: an unwritable config must not break worktree entry.
  }
}

/**
 * Clear the persisted worktree state for this session (best-effort): a null
 * transcript stamp records the exit, and every owned project slot is removed.
 */
export async function clearProjectWorktreeSlot(sessionId: string): Promise<void> {
  await stampWorktreeState(sessionId, null);
  try {
    const cfg = loadConfigSync();
    const owned = Object.values(cfg.projects ?? {}).some(
      (entry) => entry?.activeWorktreeSession?.sessionId === sessionId,
    );
    if (!owned) return;
    await updateConfig((mutable) => {
      for (const entry of Object.values(mutable.projects ?? {})) {
        if (entry?.activeWorktreeSession?.sessionId === sessionId) {
          delete entry.activeWorktreeSession;
        }
      }
    });
  } catch {
    // Best-effort: an unwritable config must not break worktree exit.
  }
}

/** Read the persisted worktree slot for this session, if any. */
export function readProjectWorktreeSlot(sessionId: string): SessionWorktreeState | null {
  try {
    const cfg = loadConfigSync();
    for (const entry of Object.values(cfg.projects ?? {})) {
      const slot = entry?.activeWorktreeSession;
      if (slot !== undefined && slot.sessionId === sessionId) return stateFromSlot(slot);
    }
  } catch {
    return null;
  }
  return null;
}
