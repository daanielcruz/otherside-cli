import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTaskOutputSession } from "@/engine/background/tasks/output-files.ts";
import { resetSandboxState } from "@/engine/sandbox/manager.ts";
import { currentGitBranch, sessionPathForCwd } from "@/engine/session/paths.ts";
import type { Session } from "@/engine/session/record/state.ts";
import { registerSession, touchSession } from "@/engine/session/registry.ts";
import { renderMemorySection } from "@/harness/core/memory-section.ts";
import { isEnvTruthy } from "@/kernel/std/proc/env.ts";
import { setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import { collectMemoryFiles } from "@/kernel/storage/memory/loader.ts";

export type RelocateSessionSource = "cd_command" | "set_cwd";

export type RelocateSessionResult = {
  modelMessage: string;
  transcriptRelocated: boolean;
};

async function renameWithFallback(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "EXDEV") {
      if ((await stat(from)).isDirectory()) {
        await cp(from, to, { recursive: true });
        await rm(from, { recursive: true, force: true });
      } else {
        await copyFile(from, to);
        await rm(from, { force: true });
      }
      return;
    }
    throw err;
  }
}

/**
 * Relocate the on-disk transcript when the session project identity changes.
 * Keeps storage under the new cwd project slug so resume from the destination
 * can find the session. Never process.chdir().
 */
export async function moveSessionTranscript(session: Session, newCwd: string): Promise<boolean> {
  const oldCwd = session.storageCwd;
  if (oldCwd === newCwd) return true;

  const oldPath = sessionPathForCwd(oldCwd, session.id);
  const newPath = sessionPathForCwd(newCwd, session.id);
  if (oldPath === newPath) {
    session.storageCwd = newCwd;
    return true;
  }

  await mkdir(dirname(newPath), { recursive: true, mode: 0o700 });

  let fileMoved = false;
  if (existsSync(oldPath)) {
    try {
      await renameWithFallback(oldPath, newPath);
      fileMoved = true;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : "";
      if (code !== "ENOENT") throw err;
    }
  }

  const oldSessionDir = join(dirname(oldPath), session.id);
  const newSessionDir = join(dirname(newPath), session.id);
  if (existsSync(oldSessionDir)) {
    try {
      await renameWithFallback(oldSessionDir, newSessionDir);
    } catch {
      // Best-effort: transcript file move is the critical piece.
    }
  }

  session.storageCwd = newCwd;
  return fileMoved || !existsSync(oldPath);
}

function formatMemoryForMove(dir: string): string {
  if (isEnvTruthy(process.env.OTHERSIDE_DISABLE_PROJECT_MEMORY)) return "";
  try {
    const files = collectMemoryFiles(dir).filter(
      (f) => f.scope === "project" || f.scope === "nested",
    );
    if (files.length === 0) return "";
    return renderMemorySection(files) ?? "";
  } catch {
    return "";
  }
}

/**
 * Apply a session working-directory change without process.chdir().
 * Updates active cwd, tracked shell cwd, optional transcript storage home,
 * git branch, task output root, registry, and sandbox state for the destination.
 */
export async function relocateSession(
  session: Session,
  dir: string,
  source: RelocateSessionSource,
): Promise<RelocateSessionResult> {
  const prevStorage = session.storageCwd;
  const prevWorktree = session.worktree;

  // Leave any active EnterWorktree overlay (keep on disk) so /cd owns both
  // active and project identity paths.
  if (session.worktree !== null) {
    session.worktree = null;
  }

  let transcriptRelocated = true;
  try {
    transcriptRelocated = await moveSessionTranscript(session, dir);
  } catch (err) {
    // Roll back storage identity if the move failed.
    session.storageCwd = prevStorage;
    session.worktree = prevWorktree;
    throw err;
  }

  session.cwd = dir;
  setTrackedCwd(dir);
  resetSandboxState();

  const branch = currentGitBranch(dir);
  if (branch) session.gitBranch = branch;
  else delete session.gitBranch;

  setTaskOutputSession({ sessionId: session.id, cwd: dir });
  registerSession(session.id, dir);
  touchSession(session.id, dir);

  const moveSource = source === "cd_command" ? "via /cd" : "by the user";
  const modelMessageCore =
    `The session's working directory has changed to ${dir} (${moveSource}). ` +
    `The environment block at the start of this conversation still names the previous directory — that information is stale. ` +
    `All tool calls and relative paths now resolve from ${dir}.`;
  const mds = formatMemoryForMove(dir);
  return {
    modelMessage: mds ? `${modelMessageCore}\n\n${mds}` : modelMessageCore,
    transcriptRelocated,
  };
}

export async function pathIsDirectory(
  path: string,
): Promise<
  | { ok: true; canonical: string }
  | { ok: false; reason: "not_found" | "not_a_directory"; path: string; parent?: string }
> {
  try {
    const st = await stat(path);
    if (!st.isDirectory()) {
      return { ok: false, reason: "not_a_directory", path, parent: dirname(path) };
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      return { ok: false, reason: "not_found", path };
    }
    throw err;
  }
  try {
    const { realpath } = await import("node:fs/promises");
    const canonical = await realpath(path);
    return { ok: true, canonical: canonical.normalize("NFC") };
  } catch {
    return { ok: true, canonical: path.normalize("NFC") };
  }
}
