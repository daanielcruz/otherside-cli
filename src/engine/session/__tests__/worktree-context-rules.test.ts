import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
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

let repoRoot: string;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "wt-context-rules-"));
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["config", "user.email", "test@example.invalid"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  writeFileSync(join(repoRoot, "README.md"), "fixture\n");
  git(repoRoot, ["add", "README.md"]);
  git(repoRoot, ["commit", "-q", "-m", "fixture"]);
});

afterAll(() => {
  for (const sessionId of attachedSessions) detachSessionWorktreeHost(sessionId);
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("worktree agent-context rules", () => {
  it("rejects creation from a plain subagent context", async () => {
    await expect(
      enterSessionWorktree(agentCtx(repoRoot, "wt-rules-agent-create"), { name: "agent-made" }),
    ).rejects.toThrow(/cannot create a worktree from a subagent/);
  });

  it("rejects Exit from an agent even when it owns the entered controller", async () => {
    const sessionId = "wt-rules-agent-exit";
    const main = mainCtx(repoRoot, sessionId);
    const created = await enterSessionWorktree(main, { name: "agent-exit-fixture" });
    await exitSessionWorktree(main, { action: "keep" });

    const agent = agentCtx(repoRoot, sessionId);
    const entered = await enterSessionWorktree(agent, { path: created.worktreePath });
    expect(entered.worktreePath).toBe(created.worktreePath);

    await expect(exitSessionWorktree(agent, { action: "keep" })).rejects.toThrow(
      /ExitWorktree cannot be called from a subagent/,
    );
  });

  it("creates a sibling at the main root when launched inside a managed worktree", async () => {
    const sessionId = "wt-rules-nested-create";
    const main = mainCtx(repoRoot, sessionId);
    const created = await enterSessionWorktree(main, { name: "nested-launch-fixture" });
    await exitSessionWorktree(main, { action: "keep" });

    // A fresh session launched inside a managed worktree has no controller
    // state; creation anchors at the main checkout and yields a sibling.
    const relaunched = mainCtx(created.worktreePath, "wt-rules-nested-create-relaunch");
    const sibling = await enterSessionWorktree(relaunched, { name: "nested-child" });
    expect(realpathSync(sibling.worktreePath)).toBe(
      realpathSync(join(repoRoot, ".otherside", "worktrees", "nested-child")),
    );
    const exited = await exitSessionWorktree(relaunched, { action: "remove" });
    // Exit returns to the launch directory — the previous worktree.
    expect(realpathSync(exited.originalCwd)).toBe(realpathSync(created.worktreePath));
    git(repoRoot, ["worktree", "remove", "--force", created.worktreePath]);
  });

  it("still allows main-session creation and removal", async () => {
    const main = mainCtx(repoRoot, "wt-rules-main-lifecycle");
    const created = await enterSessionWorktree(main, { name: "main-lifecycle" });
    expect(created.worktreePath).toContain(join(".otherside", "worktrees"));
    const exited = await exitSessionWorktree(main, { action: "remove" });
    expect(exited.action).toBe("remove");
  });
});
