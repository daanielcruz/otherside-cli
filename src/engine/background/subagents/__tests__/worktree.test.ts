import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as filesystem from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, relative, win32 } from "node:path";
import {
  acquireResumedWorktreeLease,
  acquireWorktreeLease,
  createWorktree,
  findNestedRepos,
  isPathWithinRoot,
  isWriteEscapingWorktree,
  pruneOrphanWorktrees,
  setWorktreeCleanupRemovalHookForTests,
  setWorktreeCleanupValidationHookForTests,
  setWorktreeOverlayCopyHookForTests,
} from "../worktree.ts";
import * as worktreeGit from "../worktree-git.ts";
import { setNestedWorktreeRemovalHookForTests } from "../worktree-nested-repos.ts";

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "otherside-worktree-test-"));
});

afterEach(async () => {
  setWorktreeCleanupValidationHookForTests(null);
  setWorktreeCleanupRemovalHookForTests(null);
  setWorktreeOverlayCopyHookForTests(null);
  setNestedWorktreeRemovalHookForTests(null);
  await rm(tempDir, { recursive: true, force: true });
});

describe("worktree nested repo detection", () => {
  test("returns empty list for a clean directory without nested repos", async () => {
    const result = await findNestedRepos(tempDir);
    expect(result).toEqual([]);
  });

  test("ignores toplevel .git directory", async () => {
    await mkdir(join(tempDir, ".git"), { recursive: true });
    const result = await findNestedRepos(tempDir);
    expect(result).toEqual([]);
  });

  test("detects a nested repo at depth 1 (immediate subdirectory containing .git)", async () => {
    const subRepo = join(tempDir, "nested-repo-1");
    await mkdir(join(subRepo, ".git"), { recursive: true });
    const result = await findNestedRepos(tempDir);
    expect(result).toEqual([subRepo]);
  });

  test("detects a nested repo at depth 2 (subdirectory of subdirectory containing .git)", async () => {
    const parentDir = join(tempDir, "intermediate-dir");
    const subRepo = join(parentDir, "nested-repo-2");
    await mkdir(join(subRepo, ".git"), { recursive: true });
    const result = await findNestedRepos(tempDir);
    expect(result).toEqual([subRepo]);
  });

  test("ignores common ignored folders like node_modules, .otherside, .githooks", async () => {
    const nmRepo = join(tempDir, "node_modules", "some-pkg");
    await mkdir(join(nmRepo, ".git"), { recursive: true });

    const osRepo = join(tempDir, ".otherside", "worktrees", "wt");
    await mkdir(join(osRepo, ".git"), { recursive: true });

    const ghRepo = join(tempDir, ".githooks", "hooks");
    await mkdir(join(ghRepo, ".git"), { recursive: true });

    const result = await findNestedRepos(tempDir);
    expect(result).toEqual([]);
  });
});

describe("isWriteEscapingWorktree", () => {
  test("dest inside root -> false", async () => {
    const root = join(tempDir, "root");
    await mkdir(root, { recursive: true });
    const dest = join(root, "file.txt");
    await writeFile(dest, "test");
    const escaped = await isWriteEscapingWorktree(dest, root);
    expect(escaped).toBe(false);
  });

  test("absolute dest outside root -> true", async () => {
    const root = join(tempDir, "root");
    await mkdir(root, { recursive: true });
    const dest = join(tempDir, "outside.txt");
    await writeFile(dest, "test");
    const escaped = await isWriteEscapingWorktree(dest, root);
    expect(escaped).toBe(true);
  });

  test("dest that is a symlink inside root pointing outside -> true", async () => {
    const root = join(tempDir, "root");
    await mkdir(root, { recursive: true });
    const target = join(tempDir, "outside.txt");
    await writeFile(target, "test");
    const link = join(root, "link.txt");
    await symlink(target, link);
    const escaped = await isWriteEscapingWorktree(link, root);
    expect(escaped).toBe(true);
  });

  test("deep non-existent dest under root (missing intermediate dirs) -> false", async () => {
    const root = join(tempDir, "root");
    await mkdir(root, { recursive: true });
    const dest = join(root, "missing1", "missing2", "file.txt");
    const escaped = await isWriteEscapingWorktree(dest, root);
    expect(escaped).toBe(false);
  });

  test("non-existent dest whose nearest existing ancestor is outside root -> true", async () => {
    const root = join(tempDir, "root");
    await mkdir(root, { recursive: true });
    const outsideDir = join(tempDir, "outside");
    await mkdir(outsideDir, { recursive: true });
    const dest = join(outsideDir, "missing", "file.txt");
    const escaped = await isWriteEscapingWorktree(dest, root);
    expect(escaped).toBe(true);
  });

  test("dest exactly equal to root -> false", async () => {
    const root = join(tempDir, "root");
    await mkdir(root, { recursive: true });
    const escaped = await isWriteEscapingWorktree(root, root);
    expect(escaped).toBe(false);
  });
});

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function commitGit(cwd: string, message: string): void {
  runGit(cwd, [
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
}

async function setupGitRepo(dir: string): Promise<void> {
  runGit(dir, ["init", "-b", "main"]);
  await writeFile(join(dir, "readme.txt"), "hello world");
  runGit(dir, ["add", "readme.txt"]);
  commitGit(dir, "initial commit");
}

describe("worktree cwd containment", () => {
  test("accepts descendants and rejects truly outside POSIX paths", () => {
    expect(isPathWithinRoot("/repo", "/repo/packages/app")).toBe(true);
    expect(isPathWithinRoot("/repo", "/repo-other")).toBe(false);
    expect(isPathWithinRoot("/repo", "/outside")).toBe(false);
  });

  test("accepts Windows-style descendants and rejects a truly outside path", () => {
    const windowsPath = {
      relative: win32.relative,
      isAbsolute: win32.isAbsolute,
      sep: win32.sep,
    };
    expect(isPathWithinRoot("C:\\repo", "C:\\repo\\packages\\app", windowsPath)).toBe(true);
    expect(isPathWithinRoot("C:\\repo", "C:\\repo-other", windowsPath)).toBe(false);
    expect(isPathWithinRoot("C:\\repo", "C:\\outside", windowsPath)).toBe(false);
  });
});

describe("worktree root selection", () => {
  test("returns null outside a git repository", async () => {
    expect(await createWorktree(tempDir, "workflow-plain-directory")).toBeNull();
  });

  test("selects the nearest independent git root", async () => {
    const outer = join(tempDir, "outer");
    const outerChild = join(outer, "packages", "app");
    const nested = join(outer, "nested");
    const nestedChild = join(nested, "src");
    await mkdir(outerChild, { recursive: true });
    await setupGitRepo(outer);
    await mkdir(nestedChild, { recursive: true });
    await setupGitRepo(nested);

    const outerWorktree = await createWorktree(outerChild, "workflow-nearest-outer");
    expect(outerWorktree).not.toBeNull();
    if (!outerWorktree) return;
    expect(await realpath(outerWorktree.path)).toBe(
      await realpath(join(outer, ".otherside", "worktrees", "workflow-nearest-outer")),
    );
    expect(outerWorktree.warning).toContain(await realpath(nested));
    expect(await pathExists(join(outerWorktree.path, "nested", "readme.txt"))).toBe(false);
    expect((await outerWorktree.cleanup()).deleted).toBe(true);

    const nestedWorktree = await createWorktree(nestedChild, "workflow-nearest-nested");
    expect(nestedWorktree).not.toBeNull();
    if (!nestedWorktree) return;
    expect(await realpath(nestedWorktree.path)).toBe(
      await realpath(join(nested, ".otherside", "worktrees", "workflow-nearest-nested")),
    );
    expect(await readFile(join(nestedWorktree.path, "readme.txt"), "utf8")).toBe("hello world");
    expect((await nestedWorktree.cleanup()).deleted).toBe(true);
  });
});

describe("worktree lifecycle logic", () => {
  test("parent clean + agent without change gets removed", async () => {
    await setupGitRepo(tempDir);
    const wt = await createWorktree(tempDir, "fork_clean_1");
    expect(wt).not.toBeNull();
    if (!wt) return;
    const cleanupRes = await wt.cleanup();
    expect(cleanupRes.deleted).toBe(true);

    let dirExists = true;
    try {
      await stat(wt.path);
    } catch {
      dirExists = false;
    }
    expect(dirExists).toBe(false);
    expect(runGit(tempDir, ["branch", "--list", wt.branch]).trim()).toBe("");
  });

  test("parent with tracked dirty and untracked + agent without change gets removed", async () => {
    await setupGitRepo(tempDir);
    await writeFile(join(tempDir, "readme.txt"), "hello dirty world");
    await writeFile(join(tempDir, "untracked.txt"), "some untracked text");

    const wt = await createWorktree(tempDir, "fork_dirty_1");
    expect(wt).not.toBeNull();
    if (!wt) return;

    const readmeContent = await readFile(join(wt.path, "readme.txt"), "utf-8");
    expect(readmeContent).toBe("hello dirty world");
    const untrackedContent = await readFile(join(wt.path, "untracked.txt"), "utf-8");
    expect(untrackedContent).toBe("some untracked text");

    const cleanupRes = await wt.cleanup();
    expect(cleanupRes.deleted).toBe(true);

    let dirExists = true;
    try {
      await stat(wt.path);
    } catch {
      dirExists = false;
    }
    expect(dirExists).toBe(false);
  });

  test("copies tracked dirty bytes without UTF-8 corruption", async () => {
    await setupGitRepo(tempDir);
    runGit(tempDir, ["config", "core.autocrlf", "true"]);
    const binary = Buffer.from([0x80, 0x0a]);
    await writeFile(join(tempDir, "readme.txt"), binary);

    const wt = await createWorktree(tempDir, "workflow-binary-overlay");
    expect(wt).not.toBeNull();
    if (!wt) return;

    expect(await readFile(join(wt.path, "readme.txt"))).toEqual(binary);
    expect((await wt.cleanup()).deleted).toBe(true);
  });

  test("agent alters a file that was already dirty in the baseline -> preserved", async () => {
    await setupGitRepo(tempDir);
    await writeFile(join(tempDir, "readme.txt"), "hello dirty world");

    const wt = await createWorktree(tempDir, "fork_dirty_preserve");
    expect(wt).not.toBeNull();
    if (!wt) return;

    await writeFile(join(wt.path, "readme.txt"), "hello agent modified world");

    const cleanupRes = await wt.cleanup();
    expect(cleanupRes.deleted).toBe(false);

    let dirExists = true;
    try {
      await stat(wt.path);
    } catch {
      dirExists = false;
    }
    expect(dirExists).toBe(true);
  });

  test("agent writes new untracked file -> preserved", async () => {
    await setupGitRepo(tempDir);
    const wt = await createWorktree(tempDir, "fork_new_untracked");
    expect(wt).not.toBeNull();
    if (!wt) return;

    await writeFile(join(wt.path, "agent-new.txt"), "agent content");

    const cleanupRes = await wt.cleanup();
    expect(cleanupRes.deleted).toBe(false);

    let dirExists = true;
    try {
      await stat(wt.path);
    } catch {
      dirExists = false;
    }
    expect(dirExists).toBe(true);
  });

  // The incident shape: the nested checkout lands on a path the outer repo
  // GITIGNORES, so the baseline fingerprint (exclude-standard) cannot see it
  // and only the nested-repo gate stands between the work and deletion.
  async function setupRepoIgnoringNested(dir: string, ignored: string): Promise<void> {
    await setupGitRepo(dir);
    await writeFile(join(dir, ".gitignore"), `/${ignored}/\n`);
    runGit(dir, ["add", ".gitignore"]);
    commitGit(dir, "ignore nested checkout dir");
  }

  test("dirty nested linked worktree of a child repo -> area preserved", async () => {
    await setupRepoIgnoringNested(tempDir, "child-checkout");
    const childRepo = join(tempDir, "child-project");
    await mkdir(childRepo, { recursive: true });
    await setupGitRepo(childRepo);
    const wt = await createWorktree(tempDir, "fork_nested_dirty");
    expect(wt).not.toBeNull();
    if (!wt) return;

    const nestedPath = join(wt.path, "child-checkout");
    runGit(childRepo, ["worktree", "add", "--detach", nestedPath]);
    await writeFile(join(nestedPath, "readme.txt"), "uncommitted nested work");

    const cleanupRes = await wt.cleanup();
    expect(cleanupRes.deleted).toBe(false);
    expect(await pathExists(nestedPath)).toBe(true);
  });

  test.each([
    "absolute",
    "relative",
  ])("clean nested linked worktree with %s forward-slash pointer -> area removed and owner metadata pruned", async (pointerKind) => {
    await setupRepoIgnoringNested(tempDir, "child-checkout");
    const childRepo = join(tempDir, "child-project");
    await mkdir(childRepo, { recursive: true });
    await setupGitRepo(childRepo);
    const wt = await createWorktree(tempDir, "fork_nested_clean");
    expect(wt).not.toBeNull();
    if (!wt) return;

    const nestedPath = join(wt.path, "child-checkout");
    runGit(childRepo, ["worktree", "add", "--detach", nestedPath]);
    const adminDir = runGit(nestedPath, ["rev-parse", "--absolute-git-dir"]).trim();
    const pointer = pointerKind === "relative" ? relative(nestedPath, adminDir) : adminDir;
    await writeFile(join(nestedPath, ".git"), `gitdir: ${pointer.replaceAll("\\", "/")}\n`);

    const cleanupRes = await wt.cleanup();
    expect(cleanupRes.deleted).toBe(true);
    expect(await pathExists(wt.path)).toBe(false);
    const registered = runGit(childRepo, ["worktree", "list", "--porcelain"]);
    expect(registered).not.toContain("child-checkout");
  });

  test("full nested repo owning its object database -> area preserved", async () => {
    await setupRepoIgnoringNested(tempDir, "scratch-repo");
    const wt = await createWorktree(tempDir, "fork_nested_full");
    expect(wt).not.toBeNull();
    if (!wt) return;

    const nestedPath = join(wt.path, "scratch-repo");
    await mkdir(nestedPath, { recursive: true });
    await setupGitRepo(nestedPath);

    const cleanupRes = await wt.cleanup();
    expect(cleanupRes.deleted).toBe(false);
    expect(await pathExists(nestedPath)).toBe(true);
  });

  test.each([
    "invalid pointer",
    "gitdir: ../not-linked",
    "gitdir: ../missing/.git/worktrees/child",
  ])("invalid nested pointer %s -> area preserved", async (pointer) => {
    await setupRepoIgnoringNested(tempDir, "child-checkout");
    const wt = await createWorktree(tempDir, "fork_nested_invalid");
    expect(wt).not.toBeNull();
    if (!wt) return;

    const nestedPath = join(wt.path, "child-checkout");
    await mkdir(nestedPath, { recursive: true });
    await writeFile(join(nestedPath, ".git"), `${pointer}\n`);
    await writeFile(join(nestedPath, "readme.txt"), "nested work");

    expect((await wt.cleanup()).deleted).toBe(false);
    expect(await readFile(join(nestedPath, "readme.txt"), "utf8")).toBe("nested work");
  });

  test.each([
    "readme.txt",
    "new-work.txt",
  ])("a nested write to %s before its removal preserves both checkouts", async (filename) => {
    await setupRepoIgnoringNested(tempDir, "child-checkout");
    const owner = join(tempDir, "child-project");
    await mkdir(owner, { recursive: true });
    await setupGitRepo(owner);
    const wt = await createWorktree(tempDir, "fork_nested_write");
    expect(wt).not.toBeNull();
    if (!wt) return;
    const child = join(wt.path, "child-checkout");
    runGit(owner, ["worktree", "add", "--detach", child]);
    setNestedWorktreeRemovalHookForTests(async (path) => {
      await writeFile(join(path, filename), "late nested work");
    });

    expect((await wt.cleanup()).deleted).toBe(false);
    expect(await readFile(join(child, filename), "utf8")).toBe("late nested work");
    expect(await realpath(runGit(wt.path, ["rev-parse", "--show-toplevel"]).trim())).toBe(
      await realpath(wt.path),
    );
    expect(runGit(child, ["status", "--porcelain"])).toContain(filename);
  });

  test.each([
    "readme.txt",
    "new-work.txt",
  ])("the child Git refuses a late write to %s after application validation", async (filename) => {
    await setupRepoIgnoringNested(tempDir, "child-checkout");
    const owner = join(tempDir, "child-project");
    await mkdir(owner, { recursive: true });
    await setupGitRepo(owner);
    const wt = await createWorktree(tempDir, "fork_nested_git_guard");
    expect(wt).not.toBeNull();
    if (!wt) return;
    const child = join(wt.path, "child-checkout");
    runGit(owner, ["worktree", "add", "--detach", child]);
    const execute = worktreeGit.git;
    let attempted = false;
    const intercepted = spyOn(worktreeGit, "git").mockImplementation(async (cwd, args) => {
      if (args[0] === "worktree" && args[1] === "remove" && args.at(-1) === child) {
        attempted = true;
        expect(args).not.toContain("--force");
        await writeFile(join(child, filename), "written at Git boundary");
      }
      return execute(cwd, args);
    });
    try {
      expect((await wt.cleanup()).deleted).toBe(false);
    } finally {
      intercepted.mockRestore();
    }
    expect(attempted).toBe(true);
    expect(await readFile(join(child, filename), "utf8")).toBe("written at Git boundary");
    expect(runGit(child, ["status", "--porcelain"])).toContain(filename);
    expect(await pathExists(wt.path)).toBe(true);
  });

  test("a forged nested pointer never changes the registered checkout", async () => {
    await setupRepoIgnoringNested(tempDir, "child-checkout");
    const owner = join(tempDir, "child-project");
    await mkdir(owner, { recursive: true });
    await setupGitRepo(owner);
    const wt = await createWorktree(tempDir, "fork_nested_forged");
    expect(wt).not.toBeNull();
    if (!wt) return;
    const registered = join(tempDir, "registered-checkout");
    runGit(owner, ["worktree", "add", "--detach", registered]);
    const pointer = await readFile(join(registered, ".git"), "utf8");
    const admin = runGit(registered, ["rev-parse", "--absolute-git-dir"]).trim();
    const backlink = await readFile(join(admin, "gitdir"), "utf8");
    const forged = join(wt.path, "child-checkout");
    await mkdir(forged, { recursive: true });
    await writeFile(join(forged, ".git"), pointer);
    await writeFile(join(forged, "readme.txt"), "hello world");

    expect((await wt.cleanup()).deleted).toBe(false);
    expect(await readFile(join(admin, "gitdir"), "utf8")).toBe(backlink);
    expect(await readFile(join(registered, "readme.txt"), "utf8")).toBe("hello world");
    expect(await readFile(join(forged, "readme.txt"), "utf8")).toBe("hello world");
    expect(runGit(registered, ["status", "--porcelain"])).toBe("");
  });

  test("a second nested removal refusal preserves the parent and remaining child", async () => {
    await setupRepoIgnoringNested(tempDir, "children");
    const owner = join(tempDir, "child-project");
    await mkdir(owner, { recursive: true });
    await setupGitRepo(owner);
    const wt = await createWorktree(tempDir, "fork_nested_partial");
    expect(wt).not.toBeNull();
    if (!wt) return;
    await mkdir(join(wt.path, "children"), { recursive: true });
    for (const name of ["one", "two"]) {
      runGit(owner, ["worktree", "add", "--detach", join(wt.path, "children", name)]);
    }
    const visited: string[] = [];
    setNestedWorktreeRemovalHookForTests(async (path) => {
      visited.push(path);
      if (visited.length === 2) await writeFile(join(path, "readme.txt"), "keep second child");
    });

    expect((await wt.cleanup()).deleted).toBe(false);
    expect(visited).toHaveLength(2);
    expect(await pathExists(visited[0] ?? "")).toBe(false);
    expect(await readFile(join(visited[1] ?? "", "readme.txt"), "utf8")).toBe("keep second child");
    expect(await realpath(runGit(wt.path, ["rev-parse", "--show-toplevel"]).trim())).toBe(
      await realpath(wt.path),
    );
    expect(runGit(visited[1] ?? "", ["status", "--porcelain"])).toContain("readme.txt");
  });

  test.each([
    "full",
    "invalid",
    "linked",
  ])("a %s nested repository created after sealing preserves the original parent path", async (kind) => {
    await setupRepoIgnoringNested(tempDir, "new-child");
    const owner = join(tempDir, "child-project");
    await mkdir(owner, { recursive: true });
    await setupGitRepo(owner);
    const wt = await createWorktree(tempDir, "fork_nested_after_seal");
    expect(wt).not.toBeNull();
    if (!wt) return;
    setWorktreeCleanupRemovalHookForTests(async (quarantine) => {
      const child = join(quarantine, "new-child");
      await mkdir(child, { recursive: true });
      if (kind === "full") await setupGitRepo(child);
      else if (kind === "linked") runGit(owner, ["worktree", "add", "--detach", child]);
      else await writeFile(join(child, ".git"), "invalid pointer\n");
      await writeFile(join(child, "valuable.txt"), "created after seal");
    });

    expect((await wt.cleanup()).deleted).toBe(false);
    expect(await readFile(join(wt.path, "new-child", "valuable.txt"), "utf8")).toBe(
      "created after seal",
    );
    expect(await realpath(runGit(wt.path, ["rev-parse", "--show-toplevel"]).trim())).toBe(
      await realpath(wt.path),
    );
  });

  test("a nested repository appearing during the move is preserved before sealing", async () => {
    await setupRepoIgnoringNested(tempDir, "new-child");
    const wt = await createWorktree(tempDir, "fork_nested_after_move");
    expect(wt).not.toBeNull();
    if (!wt) return;
    const execute = worktreeGit.git;
    let injected = false;
    const intercepted = spyOn(worktreeGit, "git").mockImplementation(async (cwd, args) => {
      const result = await execute(cwd, args);
      const destination = args.at(-1);
      if (result.ok && args[0] === "worktree" && args[1] === "move" && !injected && destination) {
        injected = true;
        const child = join(destination, "new-child");
        await mkdir(child, { recursive: true });
        await setupGitRepo(child);
        await writeFile(join(child, "valuable.txt"), "created during move");
      }
      return result;
    });
    try {
      expect((await wt.cleanup()).deleted).toBe(false);
    } finally {
      intercepted.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await readFile(join(wt.path, "new-child", "valuable.txt"), "utf8")).toBe(
      "created during move",
    );
    expect(await realpath(runGit(wt.path, ["rev-parse", "--show-toplevel"]).trim())).toBe(
      await realpath(wt.path),
    );
  });

  test.each([
    "node_modules",
    ".otherside",
    "deep/one/two/three",
    "ignored/.GIT",
  ])("a full repository under %s is never hidden from the removal gate", async (container) => {
    const top = container.split("/")[0] ?? container;
    await setupRepoIgnoringNested(tempDir, top);
    const wt = await createWorktree(tempDir, "fork_nested_deep");
    expect(wt).not.toBeNull();
    if (!wt) return;
    const child = join(wt.path, container, "child");
    await mkdir(child, { recursive: true });
    await setupGitRepo(child);
    await writeFile(join(child, "valuable.txt"), "deep nested work");

    expect((await wt.cleanup()).deleted).toBe(false);
    expect(await readFile(join(child, "valuable.txt"), "utf8")).toBe("deep nested work");
    expect(await pathExists(join(child, ".git", "objects"))).toBe(true);
  });

  test.each([
    "inventory",
    "quarantine",
  ])("an incomplete %s inspection preserves the area", async (stage) => {
    await setupRepoIgnoringNested(tempDir, "unreadable");
    const wt = await createWorktree(tempDir, "fork_nested_unreadable");
    expect(wt).not.toBeNull();
    if (!wt) return;
    await mkdir(join(wt.path, "unreadable"), { recursive: true });
    await writeFile(join(wt.path, "unreadable", "valuable.txt"), "uninspected work");
    const readDirectory = spyOn(filesystem, "readdir");
    const denyRead = () => {
      readDirectory.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    };
    if (stage === "inventory") denyRead();
    else setWorktreeCleanupRemovalHookForTests(denyRead);
    try {
      expect((await wt.cleanup()).deleted).toBe(false);
    } finally {
      readDirectory.mockRestore();
    }
    expect(await readFile(join(wt.path, "unreadable", "valuable.txt"), "utf8")).toBe(
      "uninspected work",
    );
    expect(await realpath(runGit(wt.path, ["rev-parse", "--show-toplevel"]).trim())).toBe(
      await realpath(wt.path),
    );
  });

  test.each([
    "force",
    "filesystem",
  ])("a nested repository appearing before the %s fallback preserves the checkout", async (fallback) => {
    await setupRepoIgnoringNested(tempDir, "new-child");
    const wt = await createWorktree(tempDir, "fork_nested_fallback");
    expect(wt).not.toBeNull();
    if (!wt) return;
    const execute = worktreeGit.git;
    let attempts = 0;
    const intercepted = spyOn(worktreeGit, "git").mockImplementation(async (cwd, args) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        attempts += 1;
        if ((fallback === "force" && attempts === 1) || attempts === 2) {
          const quarantine = args.at(-1);
          if (quarantine === undefined) throw new Error("missing removal path");
          const child = join(quarantine, "new-child");
          await mkdir(child, { recursive: true });
          await setupGitRepo(child);
          await writeFile(join(child, "valuable.txt"), "fallback nested work");
        }
        return { ok: false, stdout: "" };
      }
      return execute(cwd, args);
    });
    try {
      expect((await wt.cleanup()).deleted).toBe(false);
    } finally {
      intercepted.mockRestore();
    }
    expect(attempts).toBe(fallback === "force" ? 1 : 2);
    expect(await readFile(join(wt.path, "new-child", "valuable.txt"), "utf8")).toBe(
      "fallback nested work",
    );
    expect(await realpath(runGit(wt.path, ["rev-parse", "--show-toplevel"]).trim())).toBe(
      await realpath(wt.path),
    );
  });

  test("agent commits a local change -> preserved", async () => {
    await setupGitRepo(tempDir);
    const wt = await createWorktree(tempDir, "fork_local_commit");
    expect(wt).not.toBeNull();
    if (!wt) return;

    await writeFile(join(wt.path, "readme.txt"), "changed by agent commit");
    runGit(wt.path, ["add", "readme.txt"]);
    commitGit(wt.path, "agent commit");

    const cleanupRes = await wt.cleanup();
    expect(cleanupRes.deleted).toBe(false);

    let dirExists = true;
    try {
      await stat(wt.path);
    } catch {
      dirExists = false;
    }
    expect(dirExists).toBe(true);
  });

  test("second createWorktree with same key reuses path and preserves changes", async () => {
    await setupGitRepo(tempDir);
    const wt1 = await createWorktree(tempDir, "fork_reuse");
    expect(wt1).not.toBeNull();
    if (!wt1) return;

    await writeFile(join(wt1.path, "agent-mod.txt"), "agent content");

    const wt2 = await createWorktree(tempDir, "fork_reuse");
    expect(wt2).not.toBeNull();
    if (!wt2) return;

    expect(wt2.path).toBe(wt1.path);

    const content = await readFile(join(wt2.path, "agent-mod.txt"), "utf-8");
    expect(content).toBe("agent content");

    const cleanupRes = await wt2.cleanup();
    expect(cleanupRes.deleted).toBe(false);
  });

  test("serializes concurrent creation for the same stable key", async () => {
    await setupGitRepo(tempDir);
    const [first, second] = await Promise.all([
      createWorktree(tempDir, "workflow-concurrent"),
      createWorktree(tempDir, "workflow-concurrent"),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) return;
    expect(first.path).toBe(second.path);
    await writeFile(join(first.path, "agent-work.txt"), "preserve me");
    expect((await second.cleanup()).deleted).toBe(false);
  });

  test("serializes stable-key creation across processes", async () => {
    await setupGitRepo(tempDir);
    const moduleUrl = new URL("../worktree.ts", import.meta.url).href;
    const script = `import { createWorktree } from ${JSON.stringify(moduleUrl)}; const value = await createWorktree(${JSON.stringify(tempDir)}, "workflow-cross-process"); console.log(value?.path ?? "NULL");`;
    const processes = Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const outputs = await Promise.all(
      processes.map(async (proc) => {
        const stdout = (await new Response(proc.stdout).text()).trim();
        const stderr = await new Response(proc.stderr).text();
        expect(await proc.exited, stderr).toBe(0);
        return stdout;
      }),
    );

    expect(outputs).not.toContain("NULL");
    expect(new Set(outputs).size).toBe(1);
  });

  test("rechecks the baseline immediately before destructive cleanup", async () => {
    await setupGitRepo(tempDir);
    const wt = await createWorktree(tempDir, "workflow-cleanup-race");
    expect(wt).not.toBeNull();
    if (!wt) return;
    setWorktreeCleanupValidationHookForTests(() =>
      writeFile(join(wt.path, "late-agent-work.txt"), "valuable late work"),
    );

    expect((await wt.cleanup()).deleted).toBe(false);
    expect(await readFile(join(wt.path, "late-agent-work.txt"), "utf-8")).toBe(
      "valuable late work",
    );
  });

  test("non-force removal preserves a write after the final baseline validation", async () => {
    await setupGitRepo(tempDir);
    const wt = await createWorktree(tempDir, "workflow-post-validation-race");
    expect(wt).not.toBeNull();
    if (!wt) return;
    const readmePath = join(wt.path, "readme.txt");
    setWorktreeCleanupRemovalHookForTests(async (quarantinePath) => {
      await writeFile(join(quarantinePath, "readme.txt"), "valuable late work");
    });

    expect((await wt.cleanup()).deleted).toBe(false);
    expect(await readFile(readmePath, "utf-8")).toStartWith("valuable late work");
  });

  test("creates nested isolation under the common repo root and snapshots the active worktree", async () => {
    await setupGitRepo(tempDir);
    const sourcePath = join(tempDir, "linked-source");
    runGit(tempDir, ["worktree", "add", "-b", "linked-source", sourcePath, "HEAD"]);
    await writeFile(join(sourcePath, "readme.txt"), "dirty linked source");

    const wt = await createWorktree(sourcePath, "workflow-linked-root");
    expect(wt).not.toBeNull();
    if (!wt) return;

    expect(await realpath(wt.path)).toBe(
      await realpath(join(tempDir, ".otherside", "worktrees", "workflow-linked-root")),
    );
    expect(await readFile(join(wt.path, "readme.txt"), "utf-8")).toBe("dirty linked source");
    expect((await wt.cleanup()).deleted).toBe(true);
  });

  test("reuses a valid worktree without a readable baseline but never deletes it", async () => {
    await setupGitRepo(tempDir);
    const wt = await createWorktree(tempDir, "workflow-missing-baseline");
    expect(wt).not.toBeNull();
    if (!wt) return;
    const gitDir = runGit(wt.path, ["rev-parse", "--path-format=absolute", "--git-dir"]).trim();
    await rm(join(gitDir, "otherside-base.json"));

    const reused = await createWorktree(tempDir, "workflow-missing-baseline");
    expect(reused).not.toBeNull();
    if (!reused) return;
    expect(reused.path).toBe(wt.path);
    expect(await reused.cleanup()).toEqual({ deleted: false });
  });

  test("rejects an occupied path that is not the expected linked worktree", async () => {
    await setupGitRepo(tempDir);
    await mkdir(join(tempDir, ".otherside", "worktrees", "workflow-occupied"), {
      recursive: true,
    });

    expect(createWorktree(tempDir, "workflow-occupied")).rejects.toThrow(
      "existing path is not the expected linked worktree",
    );
  });

  test("prune preserves worktrees with modifications, and removes orphan stale identical to baseline", async () => {
    await setupGitRepo(tempDir);

    const wtStale = await createWorktree(tempDir, "workflow-stale");
    expect(wtStale).not.toBeNull();
    if (!wtStale) return;

    const wtModified = await createWorktree(tempDir, "workflow-modified");
    expect(wtModified).not.toBeNull();
    if (!wtModified) return;
    await writeFile(join(wtModified.path, "changed.txt"), "mod");

    const cutoff = Date.now() + 60000;

    const prunedCount = await pruneOrphanWorktrees({ cwd: tempDir, cutoff });
    expect(prunedCount).toBe(1);

    let staleExists = true;
    try {
      await stat(wtStale.path);
    } catch {
      staleExists = false;
    }
    expect(staleExists).toBe(false);

    let modifiedExists = true;
    try {
      await stat(wtModified.path);
    } catch {
      modifiedExists = false;
    }
    expect(modifiedExists).toBe(true);
  });
});

describe("worktree lease and creation rollback", () => {
  test("a held lease blocks orphan pruning even past the cutoff", async () => {
    await setupGitRepo(tempDir);
    const wt = await createWorktree(tempDir, "workflow-leased");
    expect(wt).not.toBeNull();
    if (!wt) return;

    const lease = await acquireWorktreeLease(wt.path);
    const cutoff = Date.now() + 60000; // treat everything as past the cutoff

    expect(await pruneOrphanWorktrees({ cwd: tempDir, cutoff })).toBe(0);
    expect(await pathExists(wt.path)).toBe(true);

    // Released → the same sweep now reclaims the clean orphan.
    await lease.release();
    expect(await pruneOrphanWorktrees({ cwd: tempDir, cutoff })).toBe(1);
    expect(await pathExists(wt.path)).toBe(false);
  });

  test("acquireResumedWorktreeLease bumps the mtime and holds a lease that blocks pruning", async () => {
    await setupGitRepo(tempDir);
    const wt = await createWorktree(tempDir, "workflow-resumed");
    expect(wt).not.toBeNull();
    if (!wt) return;

    // Age the directory so the prune's mtime check alone would reclaim it.
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(wt.path, stale, stale);
    const before = await stat(wt.path);

    const lease = await acquireResumedWorktreeLease(wt.path);
    const after = await stat(wt.path);
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);

    const cutoff = Date.now() + 60000; // treat everything as past the cutoff
    expect(await pruneOrphanWorktrees({ cwd: tempDir, cutoff })).toBe(0);
    expect(await pathExists(wt.path)).toBe(true);

    // Released → the same sweep now reclaims the clean orphan.
    await lease.release();
    expect(await pruneOrphanWorktrees({ cwd: tempDir, cutoff })).toBe(1);
    expect(await pathExists(wt.path)).toBe(false);
  });

  test("a lease from a dead pid does not protect an orphan from pruning", async () => {
    await setupGitRepo(tempDir);
    const wt = await createWorktree(tempDir, "workflow-dead-lease");
    expect(wt).not.toBeNull();
    if (!wt) return;

    const gitDir = runGit(wt.path, ["rev-parse", "--path-format=absolute", "--git-dir"]).trim();
    // A crashed owner leaves its marker behind with a pid that is no longer alive.
    await writeFile(
      join(gitDir, "otherside-lease.json"),
      JSON.stringify({ version: 1, pid: 2 ** 31 - 1, host: hostname(), updatedAt: Date.now() }),
    );

    const cutoff = Date.now() + 60000;
    expect(await pruneOrphanWorktrees({ cwd: tempDir, cutoff })).toBe(1);
    expect(await pathExists(wt.path)).toBe(false);
  });

  test("skips an untracked file removed after enumeration", async () => {
    await setupGitRepo(tempDir);
    const vanished = join(tempDir, "vanished.txt");
    let removed = false;
    await writeFile(vanished, "ephemeral");
    setWorktreeOverlayCopyHookForTests(async (from) => {
      if (from.endsWith("vanished.txt")) {
        removed = true;
        await rm(from);
      }
    });

    const worktree = await createWorktree(tempDir, "workflow-vanished-untracked");
    expect(worktree).not.toBeNull();
    expect(removed).toBe(true);
    if (!worktree) return;
    expect(await pathExists(join(worktree.path, "vanished.txt"))).toBe(false);
    expect((await worktree.cleanup()).deleted).toBe(true);
  });

  test("a failed overlay copy rolls the creation back, leaving nothing reusable", async () => {
    await setupGitRepo(tempDir);
    await writeFile(join(tempDir, "untracked.txt"), "secret");
    setWorktreeOverlayCopyHookForTests(() => {
      throw new Error("injected overlay copy failure");
    });

    await expect(createWorktree(tempDir, "workflow-torn")).rejects.toThrow("worktree isolation");

    // Nothing torn survives: no linked worktree, no agent branch, no directory a
    // later reuse could adopt.
    expect(runGit(tempDir, ["worktree", "list"])).not.toContain("workflow-torn");
    expect(runGit(tempDir, ["branch", "--list", "otherside/agent/workflow-torn"]).trim()).toBe("");
    expect(await pathExists(join(tempDir, ".otherside", "worktrees", "workflow-torn"))).toBe(false);
  });

  test("does not treat a still-present source as vanished on non-ENOENT overlay failure", async () => {
    await setupGitRepo(tempDir);
    await writeFile(join(tempDir, "untracked.txt"), "secret");
    // Inject a non-ENOENT failure while the source still exists. The existence
    // probe must not swallow this — fail closed and roll the creation back.
    setWorktreeOverlayCopyHookForTests(() => {
      const err = new Error("injected EACCES overlay failure") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });

    await expect(createWorktree(tempDir, "workflow-eacces")).rejects.toThrow("worktree isolation");
    expect(runGit(tempDir, ["worktree", "list"])).not.toContain("workflow-eacces");
    expect(runGit(tempDir, ["branch", "--list", "otherside/agent/workflow-eacces"]).trim()).toBe(
      "",
    );
    expect(await pathExists(join(tempDir, ".otherside", "worktrees", "workflow-eacces"))).toBe(
      false,
    );
  });

  test("does not skip a broken untracked symlink as a vanished source", async () => {
    await setupGitRepo(tempDir);
    // Broken symlink: the link node exists (lstat ok) but its target does not
    // (stat ENOENT). Fail-closed copy must not misclassify it as vanished.
    await symlink(join(tempDir, "missing-target-does-not-exist"), join(tempDir, "broken-link"));
    setWorktreeOverlayCopyHookForTests(() => {
      const err = new Error("injected failure after broken-symlink probe") as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    });

    await expect(createWorktree(tempDir, "workflow-broken-symlink")).rejects.toThrow(
      "worktree isolation",
    );
    expect(runGit(tempDir, ["worktree", "list"])).not.toContain("workflow-broken-symlink");
    expect(
      runGit(tempDir, ["branch", "--list", "otherside/agent/workflow-broken-symlink"]).trim(),
    ).toBe("");
    expect(
      await pathExists(join(tempDir, ".otherside", "worktrees", "workflow-broken-symlink")),
    ).toBe(false);
  });
});
