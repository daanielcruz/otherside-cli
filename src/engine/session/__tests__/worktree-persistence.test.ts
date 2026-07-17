import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionPathForCwd } from "@/engine/session/paths.ts";
import type { SessionRecord } from "@/engine/session/record/schema.ts";
import type { Session } from "@/engine/session/record/state.ts";
import {
  attachSessionWorktreeHost,
  detachSessionWorktreeHost,
  enterSessionWorktree,
  exitSessionWorktree,
  readProjectWorktreeSlot,
  restoreSessionWorktreeOnResume,
  type SessionWorktreeState,
  stampedWorktreeStateFrom,
} from "@/engine/session/worktree.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "-A"]);
  git(cwd, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message,
  ]);
}

const attachedSessions: string[] = [];

interface HostFixture {
  ctx: RequestContext;
  host: Session;
}

function mainHost(cwd: string, sessionId: string): HostFixture {
  const host = {
    id: sessionId,
    cwd,
    storageCwd: cwd,
    worktree: null,
  } as unknown as Session;
  attachSessionWorktreeHost(host);
  attachedSessions.push(sessionId);
  const ctx = {
    provider: "anthropic",
    model: "test-model",
    effort: null,
    permissionMode: "default",
    sessionId,
    cwd,
  } as unknown as RequestContext;
  return { ctx, host };
}

/** Seed a transcript file for the session under its current storage cwd. */
function seedTranscript(host: Session): string {
  const path = sessionPathForCwd(host.storageCwd, host.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ type: "system", sessionId: host.id })}\n`);
  return path;
}

let fixtureRoot: string;
let originPath: string;
let repoRoot: string;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "wt-persist-"));
  originPath = join(fixtureRoot, "origin.git");
  repoRoot = join(fixtureRoot, "clone");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", originPath]);
  const seed = join(fixtureRoot, "seed");
  Bun.spawnSync(["git", "init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "README.md"), "fixture\n");
  commitAll(seed, "initial");
  git(seed, ["remote", "add", "origin", originPath]);
  git(seed, ["push", "-q", "origin", "main"]);
  Bun.spawnSync(["git", "clone", "-q", originPath, repoRoot]);
});

afterAll(() => {
  for (const sessionId of attachedSessions) detachSessionWorktreeHost(sessionId);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("worktree session persistence (project config)", () => {
  it("persists the slot on enter and clears it on exit", async () => {
    const sessionId = "wt-slot-roundtrip";
    const { ctx, host } = mainHost(repoRoot, sessionId);
    expect(readProjectWorktreeSlot(sessionId)).toBeNull();

    const created = await enterSessionWorktree(ctx, { name: "slot-roundtrip" });
    const slot = readProjectWorktreeSlot(sessionId);
    expect(slot).not.toBeNull();
    expect(slot?.activePath).toBe(created.worktreePath);
    expect(slot?.originalCwd).toBe(repoRoot);
    expect(slot?.ownership).toBe("created");

    await exitSessionWorktree(ctx, { action: "remove" });
    expect(readProjectWorktreeSlot(sessionId)).toBeNull();
    expect(host.worktree).toBeNull();
  });

  it("relocates the transcript into the worktree on enter and back on exit", async () => {
    const sessionId = "wt-transcript-follow";
    const { ctx, host } = mainHost(repoRoot, sessionId);
    const originalPath = seedTranscript(host);

    const created = await enterSessionWorktree(ctx, { name: "transcript-follow" });
    const worktreePath = created.worktreePath;
    const relocatedPath = sessionPathForCwd(worktreePath, sessionId);
    expect(host.storageCwd).toBe(worktreePath);
    expect(existsSync(relocatedPath)).toBe(true);
    expect(existsSync(originalPath)).toBe(false);

    const exited = await exitSessionWorktree(ctx, { action: "remove" });
    // The restore path is realpath'd (e.g. /var → /private/var on macOS).
    expect(realpathSync(exited.restoredCwd)).toBe(realpathSync(repoRoot));
    expect(host.storageCwd).toBe(repoRoot);
    expect(existsSync(originalPath)).toBe(true);
    expect(existsSync(relocatedPath)).toBe(false);
  });

  it("keeps the transcript with the worktree when the original directory is gone (session end)", async () => {
    const sessionId = "wt-transcript-orphan";
    const launchDir = join(fixtureRoot, "clone", "launch-here");
    mkdirSync(launchDir, { recursive: true });
    const { ctx, host } = mainHost(launchDir, sessionId);
    seedTranscript(host);

    const created = await enterSessionWorktree(ctx, { name: "transcript-orphan" });
    const relocatedPath = sessionPathForCwd(created.worktreePath, sessionId);
    expect(existsSync(relocatedPath)).toBe(true);

    rmSync(launchDir, { recursive: true, force: true });
    const exited = await exitSessionWorktree(ctx, {
      action: "keep",
      restoreStrategy: "parent-chain",
    });
    // Landed on an ancestor, not the original cwd: transcript stays put.
    expect(exited.restoredCwd).not.toBe(launchDir);
    expect(existsSync(relocatedPath)).toBe(true);
    expect(host.storageCwd).toBe(created.worktreePath);
    // The slot is still cleared on exit.
    expect(readProjectWorktreeSlot(sessionId)).toBeNull();

    // Cleanup: remove the kept worktree.
    git(repoRoot, ["worktree", "remove", "--force", created.worktreePath]);
  });

  it("restores the worktree from the slot on resume", async () => {
    const sessionId = "wt-slot-resume";
    const { ctx } = mainHost(repoRoot, sessionId);
    const created = await enterSessionWorktree(ctx, { name: "slot-resume" });

    // Simulate a process exit without worktree exit (crash / plain quit).
    detachSessionWorktreeHost(sessionId);

    const resumed = {
      id: sessionId,
      cwd: created.worktreePath,
      storageCwd: created.worktreePath,
      worktree: null,
    } as unknown as Session;
    attachedSessions.push(sessionId);
    const restore = await restoreSessionWorktreeOnResume(
      resumed,
      readProjectWorktreeSlot(sessionId),
    );
    expect(restore.restored).toBe(true);
    expect(resumed.cwd).toBe(created.worktreePath);
    expect(resumed.worktree?.activePath).toBe(created.worktreePath);
    // Slot survives a successful restore (re-persisted with current lock state).
    expect(readProjectWorktreeSlot(sessionId)?.activePath).toBe(created.worktreePath);

    const resumedCtx = {
      provider: "anthropic",
      model: "test-model",
      effort: null,
      permissionMode: "default",
      sessionId,
      cwd: resumed.cwd,
    } as unknown as RequestContext;
    await exitSessionWorktree(resumedCtx, { action: "remove" });
    expect(readProjectWorktreeSlot(sessionId)).toBeNull();
  });

  it("clears the slot and stays home when the recorded worktree is gone", async () => {
    const sessionId = "wt-slot-stale";
    const { ctx } = mainHost(repoRoot, sessionId);
    const created = await enterSessionWorktree(ctx, { name: "slot-stale" });
    detachSessionWorktreeHost(sessionId);

    git(repoRoot, ["worktree", "remove", "--force", "--force", created.worktreePath]);
    expect(readProjectWorktreeSlot(sessionId)).not.toBeNull();

    const resumed = {
      id: sessionId,
      cwd: repoRoot,
      storageCwd: repoRoot,
      worktree: null,
    } as unknown as Session;
    attachedSessions.push(sessionId);
    const restore = await restoreSessionWorktreeOnResume(
      resumed,
      readProjectWorktreeSlot(sessionId),
    );
    expect(restore.restored).toBe(false);
    expect(restore.warning).toContain("no longer exists");
    expect(resumed.cwd).toBe(repoRoot);
    expect(readProjectWorktreeSlot(sessionId)).toBeNull();
  });

  it("re-homes a session whose storage died with the worktree", async () => {
    const sessionId = "wt-slot-dead-home";
    const { ctx, host } = mainHost(repoRoot, sessionId);
    seedTranscript(host);
    const created = await enterSessionWorktree(ctx, { name: "slot-dead-home" });
    const relocatedPath = sessionPathForCwd(created.worktreePath, sessionId);
    expect(existsSync(relocatedPath)).toBe(true);
    detachSessionWorktreeHost(sessionId);

    // The transcript escaped removal (copied aside), the worktree did not.
    const savedTranscript = readFileSync(relocatedPath, "utf8");
    git(repoRoot, ["worktree", "remove", "--force", "--force", created.worktreePath]);
    mkdirSync(dirname(relocatedPath), { recursive: true });
    writeFileSync(relocatedPath, savedTranscript);

    // Resume anchors storage at the (now dead) worktree, like the reader does.
    const resumed = {
      id: sessionId,
      cwd: created.worktreePath,
      storageCwd: created.worktreePath,
      worktree: null,
    } as unknown as Session;
    attachSessionWorktreeHost(resumed);
    attachedSessions.push(sessionId);
    const restore = await restoreSessionWorktreeOnResume(
      resumed,
      readProjectWorktreeSlot(sessionId),
    );
    expect(restore.restored).toBe(false);
    // The session lands on the pre-enter anchor, transcript in tow.
    expect(resumed.cwd).toBe(repoRoot);
    expect(resumed.storageCwd).toBe(repoRoot);
    expect(existsSync(sessionPathForCwd(repoRoot, sessionId))).toBe(true);
    expect(readProjectWorktreeSlot(sessionId)).toBeNull();
  });

  it("creates a PR-reference worktree based on the fetched PR head", async () => {
    // Publish a PR head ref on the origin: a commit ahead of main.
    const prSeed = join(fixtureRoot, "pr-seed");
    Bun.spawnSync(["git", "clone", "-q", originPath, prSeed]);
    writeFileSync(join(prSeed, "pr-change.txt"), "pr\n");
    commitAll(prSeed, "pr change");
    git(prSeed, ["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
    const prHead = git(prSeed, ["rev-parse", "HEAD"]);

    const sessionId = "wt-pr-reference";
    const { ctx } = mainHost(repoRoot, sessionId);
    const created = await enterSessionWorktree(ctx, { name: "pr-7", prNumber: 7 });
    expect(created.worktreePath.endsWith(join(".otherside", "worktrees", "pr-7"))).toBe(true);
    expect(git(created.worktreePath, ["rev-parse", "HEAD"])).toBe(prHead);
    const slot = readProjectWorktreeSlot(sessionId);
    expect(slot?.worktreeName).toBe("pr-7");
    await exitSessionWorktree(ctx, { action: "remove", discardChanges: true });
  });

  it("does not persist a slot for subagent worktree switches", async () => {
    const sessionId = "wt-slot-agent";
    const externalPath = join(fixtureRoot, "agent-external-wt");
    git(repoRoot, [
      "worktree",
      "add",
      "-q",
      "-b",
      "agent-slot-branch",
      externalPath,
      "origin/main",
    ]);
    // Register a managed worktree the agent is allowed to switch into.
    const { ctx } = mainHost(repoRoot, `${sessionId}-owner`);
    const created = await enterSessionWorktree(ctx, { name: "agent-slot-target" });
    await exitSessionWorktree(ctx, { action: "keep" });

    const agentCtx = {
      provider: "anthropic",
      model: "test-model",
      effort: null,
      permissionMode: "default",
      sessionId,
      cwd: repoRoot,
      agentOwnerId: "agent-under-test",
      parentThreadId: sessionId,
    } as unknown as RequestContext;
    attachSessionWorktreeHost({
      id: sessionId,
      cwd: repoRoot,
      storageCwd: repoRoot,
      worktree: null,
    } as unknown as Session);
    attachedSessions.push(sessionId);

    await enterSessionWorktree(agentCtx, { path: created.worktreePath });
    expect(readProjectWorktreeSlot(sessionId)).toBeNull();

    git(repoRoot, ["worktree", "remove", "--force", created.worktreePath]);
    git(repoRoot, ["worktree", "remove", "--force", externalPath]);
  });
});

describe("worktree transcript stamps", () => {
  /** Real Session (not a fixture cast): stamps append through the live path. */
  async function realSessionHost(cwd: string, sessionId: string): Promise<Session> {
    const { Session } = await import("@/engine/session/record/state.ts");
    const host = new Session(sessionId, cwd);
    host.pendingMeta = null;
    attachSessionWorktreeHost(host);
    attachedSessions.push(sessionId);
    return host;
  }

  function readTranscriptRecords(cwd: string, sessionId: string): SessionRecord[] {
    const path = sessionPathForCwd(cwd, sessionId);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    return lines.flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const sidecar = parsed._os;
        return sidecar && typeof sidecar === "object" ? [sidecar as SessionRecord] : [];
      } catch {
        return [];
      }
    });
  }

  it("stamps enter and exit into the transcript and restores from the stamp", async () => {
    const sessionId = "wt-stamp-roundtrip";
    const host = await realSessionHost(repoRoot, sessionId);
    const ctx = {
      provider: "anthropic",
      model: "test-model",
      effort: null,
      permissionMode: "default",
      sessionId,
      cwd: repoRoot,
    } as unknown as RequestContext;

    const created = await enterSessionWorktree(ctx, { name: "stamp-roundtrip" });
    // Enter relocated the transcript into the worktree; the stamp went with it.
    const afterEnter = readTranscriptRecords(host.storageCwd, sessionId);
    const enterStamp = stampedWorktreeStateFrom(afterEnter);
    expect(enterStamp).toEqual({
      stamped: true,
      state: expect.objectContaining({ activePath: created.worktreePath }),
    });

    // Restore consumes the stamped state without touching the project slot.
    detachSessionWorktreeHost(sessionId);
    const resumed = await realSessionHost(created.worktreePath, `${sessionId}-r`);
    const stamped = stampedWorktreeStateFrom(afterEnter);
    const restore = await restoreSessionWorktreeOnResume(
      resumed,
      stamped.stamped ? stamped.state : null,
    );
    expect(restore.restored).toBe(true);
    expect(resumed.cwd).toBe(created.worktreePath);

    // Exit stamps null: a later resume sees the explicit exit, not stale state.
    // Enter already applied the active state to the host; re-attach and exit.
    const exitCtx = { ...ctx, cwd: created.worktreePath } as unknown as RequestContext;
    attachSessionWorktreeHost(host);
    await exitSessionWorktree(exitCtx, { action: "remove" });
    const afterExit = readTranscriptRecords(host.storageCwd, sessionId);
    expect(stampedWorktreeStateFrom(afterExit)).toEqual({ stamped: true, state: null });
  });

  it("prefers the transcript stamp and validates its shape", () => {
    const goodState = {
      activePath: "/tmp/wt",
      originalCwd: "/tmp/repo",
      ownership: "created",
    };
    const records: SessionRecord[] = [
      { type: "worktree_state", ts: "2026-01-01T00:00:00Z", sessionId: "s", state: goodState },
      { type: "worktree_state", ts: "2026-01-01T00:01:00Z", sessionId: "s", state: null },
    ] as SessionRecord[];
    // Latest stamp wins (null = explicit exit), even with an earlier live one.
    expect(stampedWorktreeStateFrom(records)).toEqual({ stamped: true, state: null });
    expect(stampedWorktreeStateFrom(records.slice(0, 1))).toEqual({
      stamped: true,
      state: goodState as unknown as SessionWorktreeState,
    });
    // Malformed stamp state degrades to null rather than restoring garbage.
    const malformed: SessionRecord[] = [
      {
        type: "worktree_state",
        ts: "2026-01-01T00:00:00Z",
        sessionId: "s",
        state: { activePath: "" },
      },
    ] as SessionRecord[];
    expect(stampedWorktreeStateFrom(malformed)).toEqual({ stamped: true, state: null });
    // No stamp at all → callers fall back to the project slot.
    expect(stampedWorktreeStateFrom([])).toEqual({ stamped: false });
  });
});

describe("worktree launch helpers", () => {
  it("parses PR references from URLs and #N forms only", async () => {
    const { parsePRReference, worktreeTmuxSessionName } = await import(
      "@/engine/session/worktree.ts"
    );
    expect(parsePRReference("https://github.com/acme/widgets/pull/123")).toBe(123);
    expect(parsePRReference("https://github.com/acme/widgets/pull/123/?tab=files")).toBe(123);
    expect(parsePRReference("#42")).toBe(42);
    expect(parsePRReference("my-feature")).toBeNull();
    expect(parsePRReference("pull/9")).toBeNull();
    expect(parsePRReference("#x1")).toBeNull();
    expect(worktreeTmuxSessionName("/tmp/my.repo", "fix/bug")).toBe("my_repo_worktree-fix+bug");
  });

  it("includes a kept worktree in the exit resume hint text", async () => {
    const { resumeExitText } = await import("@/engine/session/resume.ts");
    expect(resumeExitText("abc")).toContain("otherside --resume abc");
    expect(resumeExitText("abc", "otherside", null)).toContain("otherside --resume abc");
    expect(resumeExitText("abc", "otherside", "wt-1")).toContain(
      "otherside --worktree wt-1 --resume abc",
    );
  });
});
