import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeExitText } from "@/engine/session/resume.ts";
import {
  AmbiguousSessionTitleError,
  findSessionsByTitle,
  quoteTitleForResume,
  resolveSessionRef,
} from "@/engine/session/title/resolve.ts";
import { customTitleLine } from "@/engine/session/title/store.ts";
import { projectSlug } from "@/kernel/std/fs/paths.ts";
import { stripAnsi } from "@/terminal-runtime";

const previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
let configDir: string;
let projectCwd: string;

/** A session file carrying one user turn, optionally renamed, with a fixed mtime. */
function writeSession(id: string, options: { title?: string; ageSeconds?: number }): void {
  const dir = join(configDir, "projects", projectSlug(projectCwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const lines = [JSON.stringify({ type: "user_message", cwd: projectCwd, content: "hello" })];
  if (options.title !== undefined) lines.push(customTitleLine(id, options.title));
  writeFileSync(path, `${lines.join("\n")}\n`);
  if (options.ageSeconds !== undefined) {
    const when = new Date(Date.now() - options.ageSeconds * 1000);
    utimesSync(path, when, when);
  }
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "otherside-resume-ref-"));
  projectCwd = mkdtempSync(join(tmpdir(), "otherside-resume-proj-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(projectCwd, { recursive: true, force: true });
});

describe("resolveSessionRef", () => {
  it("answers an id from its own file without consulting any title", async () => {
    writeSession("11111111-1111-4111-8111-111111111111", { title: "the renamed one" });
    writeSession("22222222-2222-4222-8222-222222222222", {});

    const resolved = await resolveSessionRef("22222222-2222-4222-8222-222222222222", projectCwd);

    expect(resolved).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("resolves a title to the session that carries it", async () => {
    writeSession("11111111-1111-4111-8111-111111111111", { title: "ship the renderer" });
    writeSession("22222222-2222-4222-8222-222222222222", { title: "something else" });

    expect(await resolveSessionRef("ship the renderer", projectCwd)).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("matches a title regardless of case and surrounding space", async () => {
    writeSession("11111111-1111-4111-8111-111111111111", { title: "Ship The Renderer" });

    expect(await resolveSessionRef("  ship the renderer  ", projectCwd)).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("hands back an unknown value so loading reports it as not found", async () => {
    writeSession("11111111-1111-4111-8111-111111111111", { title: "ship the renderer" });

    expect(await resolveSessionRef("never used this name", projectCwd)).toBe(
      "never used this name",
    );
  });

  it("refuses to guess between sessions sharing a title, and names them", async () => {
    writeSession("11111111-1111-4111-8111-111111111111", { title: "shared", ageSeconds: 600 });
    writeSession("22222222-2222-4222-8222-222222222222", { title: "shared", ageSeconds: 60 });

    const failure = await resolveSessionRef("shared", projectCwd).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AmbiguousSessionTitleError);
    const error = failure as AmbiguousSessionTitleError;
    expect(error.matches.map((match) => match.id)).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(error.message).toContain("matches 2 sessions");
    expect(error.message).toContain("11111111-1111-4111-8111-111111111111");
    expect(error.message).toContain("22222222-2222-4222-8222-222222222222");
  });

  it("ignores a generated title, which resume cannot look up", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const dir = join(configDir, "projects", projectSlug(projectCwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.jsonl`),
      `${JSON.stringify({ type: "user_message", cwd: projectCwd, content: "hello" })}\n${JSON.stringify({ type: "ai-title", aiTitle: "guessed name", sessionId: id })}\n`,
    );

    expect(await findSessionsByTitle("guessed name", projectCwd)).toEqual([]);
  });
});

describe("resumeExitText", () => {
  it("names the session by its id when it was never renamed", () => {
    const text = stripAnsi(resumeExitText("abc", "otherside", null, null));

    expect(text).toContain("otherside --resume abc");
  });

  it("prefers the title the user gave the session", () => {
    const text = stripAnsi(resumeExitText("abc", "otherside", null, "ship the renderer"));

    expect(text).toContain('otherside --resume "ship the renderer"');
  });

  it("keeps the worktree the session belongs to", () => {
    const text = stripAnsi(resumeExitText("abc", "otherside", "wt-1", "titled"));

    expect(text).toContain('otherside --worktree wt-1 --resume "titled"');
  });

  it("escapes a title carrying quotes and backslashes", () => {
    const text = stripAnsi(resumeExitText("abc", "otherside", null, 'a "quoted" c:\\path'));

    expect(text).toContain('--resume "a \\"quoted\\" c:\\\\path"');
  });
});

describe("quoteTitleForResume", () => {
  it("wraps the title so a shell hands it over as one argument", () => {
    expect(quoteTitleForResume("two words")).toBe('"two words"');
  });
});
