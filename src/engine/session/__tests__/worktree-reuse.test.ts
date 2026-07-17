import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@/engine/session/record/state.ts";
import {
  attachSessionWorktreeHost,
  detachSessionWorktreeHost,
  enterSessionWorktree,
  exitSessionWorktree,
} from "@/engine/session/worktree.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

const attachedSessions: string[] = [];

function mainCtx(cwd: string, sessionId: string): RequestContext {
  attachSessionWorktreeHost({
    id: sessionId,
    cwd,
    storageCwd: cwd,
    worktree: null,
  } as unknown as Session);
  attachedSessions.push(sessionId);
  return {
    provider: "anthropic",
    model: "test-model",
    effort: null,
    permissionMode: "default",
    sessionId,
    cwd,
  } as unknown as RequestContext;
}

function agentCtx(cwd: string, sessionId: string): RequestContext {
  return {
    ...mainCtx(cwd, sessionId),
    agentOwnerId: "agent-under-test",
    parentThreadId: sessionId,
  } as RequestContext;
}

let fixtureRoot: string;
let originPath: string;
let repoRoot: string;

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

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "wt-reuse-"));
  originPath = join(fixtureRoot, "origin.git");
  repoRoot = join(fixtureRoot, "clone");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", originPath]);
  Bun.spawnSync(["git", "init", "-q", "-b", "main", join(fixtureRoot, "seed")]);
  const seed = join(fixtureRoot, "seed");
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

describe("reused-worktree fresh-base reset", () => {
  it("resets a pristine at-baseline worktree to the advanced remote default", async () => {
    const main = mainCtx(repoRoot, "wt-reuse-reset");
    const created = await enterSessionWorktree(main, { name: "reuse-me" });
    const baseSha = git(created.worktreePath, ["rev-parse", "HEAD"]);
    await exitSessionWorktree(main, { action: "keep" });

    commitAll(repoRoot, "advance");
    git(repoRoot, ["push", "-q", "origin", "main"]);
    const advancedSha = git(repoRoot, ["rev-parse", "origin/main"]);
    expect(advancedSha).not.toBe(baseSha);

    const again = mainCtx(repoRoot, "wt-reuse-reset-2");
    const reused = await enterSessionWorktree(again, { name: "reuse-me" });
    expect(reused.message).toContain("Reused worktree at");
    expect(reused.message).toContain(
      "its previous work was fully merged upstream, so it was reset to the current base",
    );
    expect(git(reused.worktreePath, ["rev-parse", "HEAD"])).toBe(advancedSha);
    await exitSessionWorktree(again, { action: "remove" });
  });

  it("resumes as-is when the reused worktree carries local changes", async () => {
    const main = mainCtx(repoRoot, "wt-reuse-dirty");
    const created = await enterSessionWorktree(main, { name: "reuse-dirty" });
    const headBefore = git(created.worktreePath, ["rev-parse", "HEAD"]);
    writeFileSync(join(created.worktreePath, "wip.txt"), "keep me\n");
    await exitSessionWorktree(main, { action: "keep" });

    commitAll(repoRoot, "advance again");
    git(repoRoot, ["push", "-q", "origin", "main"]);

    const again = mainCtx(repoRoot, "wt-reuse-dirty-2");
    const resumed = await enterSessionWorktree(again, { name: "reuse-dirty" });
    expect(resumed.message).toContain("was resumed as-is");
    expect(git(resumed.worktreePath, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(existsSync(join(resumed.worktreePath, "wip.txt"))).toBe(true);
    await exitSessionWorktree(again, { action: "remove", discardChanges: true });
  });
});

describe("mid-session switch to a registered external worktree", () => {
  it("allows the main session to switch outside the managed root", async () => {
    const externalPath = join(fixtureRoot, "external-wt");
    git(repoRoot, ["worktree", "add", "-q", "-b", "external-branch", externalPath]);

    const main = mainCtx(repoRoot, "wt-switch-external");
    const created = await enterSessionWorktree(main, { name: "switch-source" });
    expect(created.worktreePath).toContain(join(".otherside", "worktrees"));

    const entered = await enterSessionWorktree(main, { path: externalPath });
    expect(entered.message).toContain(`Entered worktree at ${entered.worktreePath}`);
    await exitSessionWorktree(main, { action: "keep" });
  });

  it("still rejects an agent switching outside the managed root", async () => {
    const externalPath = join(fixtureRoot, "external-wt");
    await expect(
      enterSessionWorktree(agentCtx(repoRoot, "wt-switch-external-agent"), {
        path: externalPath,
      }),
    ).rejects.toThrow(/is not under .*worktrees/);
  });
});

describe(".worktreeinclude propagation", () => {
  it("copies matching ignored files into a fresh worktree and skips the rest", async () => {
    writeFileSync(join(repoRoot, ".gitignore"), ".env\nsecrets/\nnode_modules/\n");
    writeFileSync(join(repoRoot, ".worktreeinclude"), "# local env\n.env\nsecrets/\n");
    commitAll(repoRoot, "ignore rules");
    writeFileSync(join(repoRoot, ".env"), "TOKEN=fixture\n");
    mkdirSync(join(repoRoot, "secrets"), { recursive: true });
    mkdirSync(join(repoRoot, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repoRoot, "secrets", "key.txt"), "fixture-key\n");
    writeFileSync(join(repoRoot, "node_modules", "pkg", "x.js"), "// dep\n");

    const main = mainCtx(repoRoot, "wt-include-copy");
    const created = await enterSessionWorktree(main, { name: "include-copy" });
    expect(existsSync(join(created.worktreePath, ".env"))).toBe(true);
    expect(existsSync(join(created.worktreePath, "secrets", "key.txt"))).toBe(true);
    expect(existsSync(join(created.worktreePath, "node_modules"))).toBe(false);
    await exitSessionWorktree(main, { action: "remove", discardChanges: true });
  });
});
