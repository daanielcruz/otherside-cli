import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, type Worktree } from "@/engine/background/subagents/worktree.ts";
import { getTrackedCwd, setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { disposeShellStreams, SHELLS } from "../background.ts";
import { Bash } from "../bash.ts";
import { NotebookEdit } from "../edit/notebook.ts";
import { EnterWorktree } from "../worktree-enter.ts";
import { ExitWorktree } from "../worktree-exit.ts";

const SIDECHAIN_WORKTREE_TEST =
  "EnterWorktree and ExitWorktree redirect then restore sidechain shell effects";
const SIDECHAIN_WORKTREE_CHILD = "OTHERSIDE_SIDECHAIN_WORKTREE_TEST_CHILD";

async function runSidechainWorktreeTestIsolated(): Promise<void> {
  const child = Bun.spawn(
    [process.execPath, "test", import.meta.path, "-t", SIDECHAIN_WORKTREE_TEST],
    {
      cwd: process.cwd(),
      env: { ...process.env, [SIDECHAIN_WORKTREE_CHILD]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initializeRepo(cwd: string): void {
  git(cwd, ["init", "-b", "main"]);
  writeFileSync(join(cwd, "tracked.txt"), "baseline\n");
  git(cwd, ["add", "tracked.txt"]);
  git(cwd, [
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial",
  ]);
}

function context(cwd: string, originalCwd: string): RequestContext {
  return {
    provider: "anthropic",
    model: "test-model",
    effort: null,
    permissionMode: "yolo",
    sessionId: `worktree-bash-${crypto.randomUUID()}`,
    cwd,
    originalCwd,
    worktreeRoot: cwd,
    subagentLabel: "collab_spawn",
    agentOwnerId: `owner-${crypto.randomUUID()}`,
  };
}

async function runBash(ctx: RequestContext, input: Record<string, unknown>): Promise<ToolResult> {
  const call: ToolCall = {
    id: `bash-${crypto.randomUUID()}`,
    name: "Bash",
    input: { dangerouslyDisableSandbox: true, ...input },
  };
  return Bash.run(call, ctx);
}

function shellId(result: ToolResult): string {
  const id = result.meta?.kind === "bash" ? result.meta.shell_id : undefined;
  if (typeof id !== "string") throw new Error("expected background shell id");
  return id;
}

async function waitForShell(id: string): Promise<void> {
  const shell = SHELLS.get(id);
  if (!shell?.child) throw new Error(`missing background shell ${id}`);
  await shell.child.exited;
}

describe("Agent worktree Bash execution", () => {
  let sourceRoot: string;
  let worktree: Worktree;
  let previousTrackedCwd: string;
  const shellIds: string[] = [];

  beforeEach(async () => {
    sourceRoot = mkdtempSync(join(tmpdir(), "otherside-agent-bash-worktree-"));
    initializeRepo(sourceRoot);
    const created = await createWorktree(sourceRoot, `fork_bash_${crypto.randomUUID()}`);
    if (created === null) throw new Error("failed to create integration worktree");
    worktree = created;
    previousTrackedCwd = getTrackedCwd();
    setTrackedCwd(sourceRoot);
  });

  afterEach(() => {
    setTrackedCwd(previousTrackedCwd);
    for (const id of shellIds.splice(0)) {
      const shell = SHELLS.get(id);
      if (shell) disposeShellStreams(shell);
      SHELLS.delete(id);
    }
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  test("uses ctx.cwd for foreground, explicit background, and promoted shell effects", async () => {
    const ctx = context(worktree.path, sourceRoot);

    const foreground = await runBash(ctx, {
      command: "printf foreground > foreground-write.txt",
    });
    expect(foreground.is_error).toBe(false);
    expect(readFileSync(join(worktree.path, "foreground-write.txt"), "utf8")).toBe("foreground");
    expect(existsSync(join(sourceRoot, "foreground-write.txt"))).toBe(false);

    const explicit = await runBash(ctx, {
      command: "printf explicit > explicit-background.txt",
      run_in_background: true,
    });
    const explicitId = shellId(explicit);
    shellIds.push(explicitId);
    await waitForShell(explicitId);
    expect(readFileSync(join(worktree.path, "explicit-background.txt"), "utf8")).toBe("explicit");
    expect(existsSync(join(sourceRoot, "explicit-background.txt"))).toBe(false);

    const promoted = await runBash(
      {
        ...ctx,
        backgroundController: {
          signal: () => {},
          isBackgrounded: () => false,
          signaled: Promise.resolve(),
        },
      },
      {
        command: "sleep 0.1; printf promoted > promoted-background.txt",
      },
    );
    const promotedId = shellId(promoted);
    shellIds.push(promotedId);
    await waitForShell(promotedId);
    expect(readFileSync(join(worktree.path, "promoted-background.txt"), "utf8")).toBe("promoted");
    expect(existsSync(join(sourceRoot, "promoted-background.txt"))).toBe(false);

    expect((await worktree.cleanup()).deleted).toBe(false);
    expect(existsSync(worktree.path)).toBe(true);
  });

  test(SIDECHAIN_WORKTREE_TEST, async () => {
    if (process.env[SIDECHAIN_WORKTREE_CHILD] !== "1") {
      await runSidechainWorktreeTestIsolated();
      return;
    }

    const ctx: RequestContext = {
      provider: "anthropic",
      model: "test-model",
      effort: null,
      permissionMode: "yolo",
      sessionId: `session-worktree-${crypto.randomUUID()}`,
      cwd: sourceRoot,
      agentId: `agent-${crypto.randomUUID()}`,
      subagentLabel: "collab_spawn",
      agentOwnerId: `owner-${crypto.randomUUID()}`,
    };

    // Agents never create worktrees or relocate the session: creation and
    // Exit are rejected outright, the context stays untouched, and shell
    // effects keep landing in the directory the agent was given.
    const entered = await EnterWorktree.run(
      {
        id: "enter-session-worktree",
        name: "EnterWorktree",
        input: { name: "session-effects" },
      },
      ctx,
    );
    expect(entered.is_error).toBe(true);
    expect(String(entered.content)).toContain(
      "EnterWorktree cannot create a worktree from a subagent",
    );
    expect(ctx.cwd).toBe(sourceRoot);
    expect(ctx.worktreeRoot).toBeUndefined();

    const exited = await ExitWorktree.run(
      { id: "exit-session-worktree", name: "ExitWorktree", input: { action: "keep" } },
      ctx,
    );
    expect(exited.is_error).toBe(true);
    expect(String(exited.content)).toContain("ExitWorktree cannot be called from a subagent");
    expect(ctx.cwd).toBe(sourceRoot);

    const inside = await runBash(ctx, {
      command: "printf session > agent-rejection-write.txt",
    });
    expect(inside.is_error).toBe(false);
    expect(readFileSync(join(sourceRoot, "agent-rejection-write.txt"), "utf8")).toBe("session");
  });

  test("rejects relative NotebookEdit paths instead of resolving them from process cwd", async () => {
    const result = await NotebookEdit.run(
      {
        id: "relative-notebook-edit",
        name: "NotebookEdit",
        input: {
          notebook_path: "relative.ipynb",
          edit_mode: "insert",
          new_source: "isolated",
        },
      },
      context(worktree.path, sourceRoot),
    );

    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("must be absolute");
    expect(existsSync(join(sourceRoot, "relative.ipynb"))).toBe(false);
    expect(existsSync(join(worktree.path, "relative.ipynb"))).toBe(false);
  });

  test("retains tracked cwd semantics for the main session", async () => {
    const mainCtx = context(worktree.path, sourceRoot);
    delete mainCtx.subagentLabel;
    delete mainCtx.agentOwnerId;
    delete mainCtx.worktreeRoot;
    const result = await runBash(mainCtx, {
      command: "printf main > main-session-write.txt",
    });

    expect(result.is_error).toBe(false);
    expect(readFileSync(join(sourceRoot, "main-session-write.txt"), "utf8")).toBe("main");
    expect(existsSync(join(worktree.path, "main-session-write.txt"))).toBe(false);
    expect((await worktree.cleanup()).deleted).toBe(true);
    expect(git(sourceRoot, ["branch", "--list", worktree.branch]).trim()).toBe("");
  });
});
