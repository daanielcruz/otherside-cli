import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, toNamespacedPath } from "node:path";
import { projectConfigKey, updateConfig } from "@/kernel/config/config.ts";

/**
 * Observe the real child-process APIs instead of intercepting PATH: Bun reads
 * its executable search path at startup, so a runtime PATH shim is not portable.
 */
const originalSpawnSync = childProcess.spawnSync;
const originalExecFile = childProcess.execFile;
const gitSpawns: string[][] = [];

function recordGitSpawn(file: unknown, args: unknown): void {
  if (file !== "git" || !Array.isArray(args)) return;
  gitSpawns.push(args.filter((arg): arg is string => typeof arg === "string"));
}

mock.module("node:child_process", () => ({
  ...childProcess,
  spawnSync: (file: unknown, args: unknown, ...rest: unknown[]) => {
    recordGitSpawn(file, args);
    return Reflect.apply(originalSpawnSync, childProcess, [file, args, ...rest]);
  },
  execFile: originalExecFile,
}));

const { latestSessionId, sessionCwdFilterFor, sessionPathForCwd } = await import(
  "@/engine/session/paths.ts"
);
const { loadSessionForResume } = await import("@/engine/session/reader.ts");
const { readResumeChainLines } = await import("../resume-chain.ts");
const { readSessionLines, readMainChainLines, transcriptFile } = await import(
  "../transcript-lines.ts"
);
const { readProjectWorktreeSlot } = await import("@/engine/session/worktree.ts");
const { gitAncestorRoot, worktreePathsFor, worktreePathsForAsync } = await import(
  "@/kernel/std/fs/paths.ts"
);

let fixtureRoot: string;
let repoRoot: string;
let nonRepoDir: string;
let gitPath: string;

function resetGitSpawns(): void {
  gitSpawns.length = 0;
}

function realGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync([gitPath, "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "wt-spawn-gate-"));
  gitPath = Bun.which("git") ?? "";
  if (gitPath.length === 0) throw new Error("git must be available for this test");

  nonRepoDir = join(fixtureRoot, "plain");
  mkdirSync(nonRepoDir);
  repoRoot = join(fixtureRoot, "repo");
  mkdirSync(repoRoot);
  realGit(repoRoot, ["init", "-q"]);
});

afterAll(() => {
  mock.module("node:child_process", () => childProcess);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("resume-path git spawn gate", () => {
  it("spawns no git outside a repository", async () => {
    resetGitSpawns();
    expect(gitAncestorRoot(nonRepoDir)).toBeNull();
    expect(worktreePathsFor(nonRepoDir)).toEqual([]);
    expect(await worktreePathsForAsync(nonRepoDir)).toEqual([]);
    expect(gitSpawns).toEqual([]);
  });

  it("collapses a full -c resume flow in a repo into a single git spawn", async () => {
    // Seed a plain (non-worktree) resumable transcript for the repo.
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const transcriptPath = sessionPathForCwd(repoRoot, sessionId);
    mkdirSync(join(transcriptPath, ".."), { recursive: true });
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, sessionId, cwd: repoRoot, uuid: "a0000000-0000-4000-8000-000000000001", parentUuid: null })}\n`,
    );

    resetGitSpawns();
    // The exact -c startup sequence: pick latest, load for resume, read slot.
    const picked = latestSessionId(repoRoot);
    expect(picked).toBe(sessionId);
    const load = await loadSessionForResume(sessionId, repoRoot);
    expect(load.cwd).toBe(repoRoot);
    // No slot recorded: worktree restore is never entered.
    expect(readProjectWorktreeSlot(sessionId)).toBeNull();
    expect(gitSpawns).toHaveLength(1);
    expect(gitSpawns[0]).toEqual(expect.arrayContaining(["worktree", "list", "--porcelain"]));
  });

  it("spawns nothing on a -c-shaped flow outside a repository", async () => {
    resetGitSpawns();
    expect(latestSessionId(nonRepoDir)).toBeNull();
    await sessionCwdFilterFor(nonRepoDir);
    expect(readProjectWorktreeSlot("no-such-session")).toBeNull();
    expect(gitSpawns).toEqual([]);
  });

  it("keeps a dead worktree's transcript findable through the persisted slot", async () => {
    const sessionId = "66666666-7777-4888-8999-000000000000";
    const deadWorktree = join(repoRoot, ".otherside", "worktrees", "gone");
    // Slot recorded for the repo, pointing at a worktree that no longer exists.
    const slotKey = projectConfigKey(repoRoot);
    await updateConfig((cfg) => {
      cfg.projects ??= {};
      cfg.projects[slotKey] = {
        ...cfg.projects[slotKey],
        activeWorktreeSession: {
          sessionId,
          originalCwd: repoRoot,
          activePath: deadWorktree,
          ownership: "created",
        },
      };
    });
    // The transcript lives under the dead worktree's project dir.
    const transcriptPath = sessionPathForCwd(deadWorktree, sessionId);
    mkdirSync(join(transcriptPath, ".."), { recursive: true });
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "stranded" }, sessionId, cwd: deadWorktree, uuid: "b0000000-0000-4000-8000-000000000001", parentUuid: null })}\n`,
    );

    const filter = await sessionCwdFilterFor(repoRoot);
    expect(filter.matchSet.has(deadWorktree)).toBe(true);
    // The loader accepts the relocated transcript from the original repo
    // (previously: "This session belongs to a different directory").
    const load = await loadSessionForResume(sessionId, repoRoot);
    expect(load.cwd).toBe(deadWorktree);

    await updateConfig((cfg) => {
      const entry = cfg.projects?.[slotKey];
      if (entry) delete entry.activeWorktreeSession;
    });
  });
});

describe("transcript streaming paths", () => {
  it.each([
    "ordinary",
    "extended",
  ])("reads all and selected chains through an %s path", async (shape) => {
    const priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    const priorSkip = process.env.OTHERSIDE_DISABLE_PRECOMPACT_SKIP;
    const cwd = join(parse(fixtureRoot).root, "reader-fixture");
    const sessionId = "77777777-8888-4999-8000-111111111111";
    process.env.OTHERSIDE_CONFIG_DIR = join(fixtureRoot, `reader-${shape}`);
    delete process.env.OTHERSIDE_DISABLE_PRECOMPACT_SKIP;
    try {
      let path = sessionPathForCwd(cwd, sessionId);
      if (shape === "extended") {
        while (path.length <= 320) {
          process.env.OTHERSIDE_CONFIG_DIR = join(
            process.env.OTHERSIDE_CONFIG_DIR,
            "nested-segment".repeat(4),
          );
          path = sessionPathForCwd(cwd, sessionId);
        }
        expect(path.length).toBeGreaterThan(260);
      }
      const user = JSON.stringify({
        type: "user",
        uuid: "reader-user",
        parentUuid: null,
        sessionId,
        cwd,
        message: { role: "user", content: "question" },
      });
      const abandoned = JSON.stringify({
        type: "assistant",
        uuid: "reader-abandoned",
        parentUuid: "reader-user",
        sessionId,
        cwd,
        message: { role: "assistant", content: "old branch" },
      });
      const latest = JSON.stringify({
        type: "assistant",
        uuid: "reader-latest",
        parentUuid: "reader-user",
        sessionId,
        cwd,
        message: { role: "assistant", content: "latest branch" },
      });
      const sidechain = JSON.stringify({
        type: "assistant",
        uuid: "reader-sidechain",
        parentUuid: "reader-user",
        isSidechain: true,
        sessionId,
        cwd,
        message: { role: "assistant", content: "sidechain" },
      });
      const allLines = [user, abandoned, latest, sidechain];
      const mainLines = [user, abandoned, latest];
      const currentLines = [user, latest];
      const contents = `\n${allLines.join("\n\n")}\n`;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);

      expect(await readSessionLines(sessionId)).toEqual(allLines);
      expect(await readMainChainLines(sessionId)).toEqual(mainLines);
      const selected = await readResumeChainLines(sessionId);
      expect(selected.full).toEqual(currentLines);
      expect(selected.boundary).toEqual(currentLines);
      process.env.OTHERSIDE_DISABLE_PRECOMPACT_SKIP = "true";
      const materialized = await readResumeChainLines(sessionId);
      expect(materialized.full).toEqual(mainLines);
      expect(materialized.boundary).toEqual(currentLines);
      expect(await transcriptFile(toNamespacedPath(path)).text()).toBe(contents);
      expect(readFileSync(path, "utf8")).toBe(contents);
    } finally {
      if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
      else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
      if (priorSkip === undefined) delete process.env.OTHERSIDE_DISABLE_PRECOMPACT_SKIP;
      else process.env.OTHERSIDE_DISABLE_PRECOMPACT_SKIP = priorSkip;
    }
  });
});
