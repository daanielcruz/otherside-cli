import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForkLoopExternal } from "@/engine/background/subagents/dispatcher.ts";
import type { Provider } from "@/engine/contract/types.ts";
import * as providers from "@/engine/providers/registry.ts";
import { agentTranscriptPathForCwd } from "@/engine/session/paths.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const providerId = "worktree-original-cwd-test" as RequestContext["provider"];
const model = "worktree-original-cwd-model";

type CapturedCtx = {
  cwd: string;
  originalCwd?: string;
  worktreeRoot?: string;
};

let capturedCtx: CapturedCtx | undefined;

function makeCtx(cwd: string, originalCwd?: string): RequestContext {
  return {
    provider: providerId,
    model,
    effort: null,
    permissionMode: "default",
    sessionId: `worktree-original-cwd-${crypto.randomUUID()}`,
    cwd,
    ...(originalCwd !== undefined ? { originalCwd } : {}),
  };
}

function registerProvider(events: ProviderEvent[]): void {
  const provider = {
    id: providerId,
    deferredOverrides: () => ({
      excludeFromCatalog: [],
      alwaysDeclare: [],
      emitDeferredReminder: false,
    }),
    translateRequest: (ctx: RequestContext, _messages: Message[], _tools: unknown[]) => {
      const next: CapturedCtx = { cwd: ctx.cwd };
      if (ctx.originalCwd !== undefined) next.originalCwd = ctx.originalCwd;
      if (ctx.worktreeRoot !== undefined) next.worktreeRoot = ctx.worktreeRoot;
      capturedCtx = next;
      return {};
    },
    stream: async function* () {},
    translateResponse: async function* () {
      for (const event of events) yield event;
    },
    recoverableError: () => ({ kind: "fail", reason: "test" }),
  } as unknown as Provider;
  providers.register(provider);
}

async function initGitRepo(dir: string): Promise<void> {
  const git = async (args: string[]) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`git ${args.join(" ")} failed: ${err}`);
    }
  };
  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await git(["commit", "--allow-empty", "-m", "init"]);
}

describe("worktree isolation originalCwd persistence key", () => {
  let tempDir: string;
  let prevConfigDir: string | undefined;
  let prevEphemeral: string | undefined;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "otherside-worktree-original-cwd-"));
    prevConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    prevEphemeral = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(tempDir, "config");
    process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = join(tempDir, "ephemeral-sessions");
    capturedCtx = undefined;
    await initGitRepo(tempDir);
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = prevConfigDir;
    if (prevEphemeral === undefined) delete process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
    else process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = prevEphemeral;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("sets originalCwd to pre-isolation cwd and persists transcripts under it", async () => {
    const preIsolationCwd = tempDir;
    const forkId = "fork_original_cwd_test";
    registerProvider([
      {
        kind: "text_delta",
        text: "Worktree isolation kept the original project key for persistence.",
      },
      { kind: "message_stop", stop_reason: "stop" },
    ]);

    const ctx = makeCtx(preIsolationCwd);
    const result = await runForkLoopExternal({
      ctx,
      name: "Worktree OriginalCwd Agent",
      body: "Finish normally.",
      allowSet: null,
      prompt: "Finish normally.",
      agentId: "worktree-original-cwd-agent",
      forkId,
      isolation: "worktree",
    });

    expect(result.isError).toBe(false);
    expect(result.worktreePath).toBeDefined();
    const worktreePath = result.worktreePath as string;

    // Live tool cwd is the worktree; persistence key stays pre-isolation.
    expect(capturedCtx?.cwd).toBe(worktreePath);
    expect(capturedCtx?.worktreeRoot).toBe(worktreePath);
    expect(capturedCtx?.originalCwd).toBe(preIsolationCwd);

    const goodPath = agentTranscriptPathForCwd(preIsolationCwd, ctx.sessionId, forkId);
    const badPath = agentTranscriptPathForCwd(worktreePath, ctx.sessionId, forkId);
    expect(existsSync(goodPath)).toBe(true);
    expect(existsSync(badPath)).toBe(false);
  });

  test("fails closed when requested isolation cannot create a worktree", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "otherside-worktree-no-git-"));
    registerProvider([{ kind: "message_stop", stop_reason: "stop" }]);
    try {
      await expect(
        runForkLoopExternal({
          ctx: makeCtx(nonRepo),
          name: "Unavailable Worktree Agent",
          body: "Finish normally.",
          allowSet: null,
          prompt: "Finish normally.",
          agentId: "worktree-unavailable-agent",
          isolation: "worktree",
        }),
      ).rejects.toThrow("failed to create or reuse the requested worktree");
      expect(capturedCtx).toBeUndefined();
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  test("keeps an already-set originalCwd across nested worktree rewrites", async () => {
    const outermostProject = join(tempDir, "outermost-project");
    const forkId = "fork_nested_original_cwd_test";
    registerProvider([
      {
        kind: "text_delta",
        text: "Nested worktree still keys persistence to the outermost project.",
      },
      { kind: "message_stop", stop_reason: "stop" },
    ]);

    // Parent already rewrote cwd into a worktree path but kept outermost originalCwd.
    const ctx = makeCtx(tempDir, outermostProject);
    const result = await runForkLoopExternal({
      ctx,
      name: "Nested Worktree OriginalCwd Agent",
      body: "Finish normally.",
      allowSet: null,
      prompt: "Finish normally.",
      agentId: "worktree-nested-original-cwd-agent",
      forkId,
      isolation: "worktree",
    });

    expect(result.isError).toBe(false);
    expect(result.worktreePath).toBeDefined();
    const worktreePath = result.worktreePath as string;

    expect(capturedCtx?.cwd).toBe(worktreePath);
    expect(capturedCtx?.originalCwd).toBe(outermostProject);

    const goodPath = agentTranscriptPathForCwd(outermostProject, ctx.sessionId, forkId);
    const badPath = agentTranscriptPathForCwd(worktreePath, ctx.sessionId, forkId);
    expect(existsSync(goodPath)).toBe(true);
    expect(existsSync(badPath)).toBe(false);
  });
});
