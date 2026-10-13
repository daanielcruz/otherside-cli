import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getSandboxSettings, resetSandboxState } from "@/engine/sandbox/manager.ts";
import { appendRecord } from "@/engine/session/append.ts";
import { sessionPathForCwd } from "@/engine/session/paths.ts";
import { Session } from "@/engine/session/record/state.ts";
import {
  moveSessionTranscript,
  pathIsDirectory,
  relocateSession,
} from "@/engine/session/relocate-cwd.ts";
import { canonicalizeCwd } from "@/kernel/std/fs/paths.ts";
import { getTrackedCwd, setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

describe("session cwd relocation", () => {
  let root: string;
  let source: string;
  let destination: string;
  let priorConfigDir: string | undefined;
  let priorDisableMemory: string | undefined;
  let priorTrackedCwd: string;

  beforeEach(() => {
    root = canonicalizeCwd(mkdtempSync(join(tmpdir(), "otherside-relocate-")));
    source = join(root, "source");
    destination = join(root, "destination");
    mkdirSync(source);
    mkdirSync(destination);
    priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    priorDisableMemory = process.env.OTHERSIDE_DISABLE_PROJECT_MEMORY;
    priorTrackedCwd = getTrackedCwd();
    process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
    delete process.env.OTHERSIDE_DISABLE_PROJECT_MEMORY;
    setTrackedCwd(source);
    resetSandboxState();
  });

  afterEach(() => {
    setTrackedCwd(priorTrackedCwd);
    if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
    if (priorDisableMemory === undefined) delete process.env.OTHERSIDE_DISABLE_PROJECT_MEMORY;
    else process.env.OTHERSIDE_DISABLE_PROJECT_MEMORY = priorDisableMemory;
    resetSandboxState();
    rmSync(root, { recursive: true, force: true });
  });

  it("moves transcript storage and its session directory", async () => {
    const session = new Session("relocate-storage", source);
    const oldPath = sessionPathForCwd(source, session.id);
    const newPath = sessionPathForCwd(destination, session.id);
    mkdirSync(dirname(oldPath), { recursive: true });
    writeFileSync(oldPath, '{"type":"session_meta"}\n');
    const oldSessionDir = join(dirname(oldPath), session.id);
    mkdirSync(oldSessionDir);
    writeFileSync(join(oldSessionDir, "artifact.txt"), "artifact");

    expect(await moveSessionTranscript(session, destination)).toBe(true);
    expect(session.storageCwd).toBe(destination);
    expect(existsSync(oldPath)).toBe(false);
    expect(readFileSync(newPath, "utf8")).toContain("session_meta");
    expect(readFileSync(join(dirname(newPath), session.id, "artifact.txt"), "utf8")).toBe(
      "artifact",
    );
  });

  it("updates shell cwd, branch state, sandbox settings, and destination memory", async () => {
    writeFileSync(join(destination, "OTHERSIDE.md"), "destination instruction");
    const configPath = join(process.env.OTHERSIDE_CONFIG_DIR!, "settings.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ sandbox: { enabled: false } }));
    expect(getSandboxSettings().enabled).toBe(false);
    writeFileSync(configPath, JSON.stringify({ sandbox: { enabled: true } }));

    const session = new Session("relocate-state", source);
    const result = await relocateSession(session, destination, "cd_command");

    expect(session.cwd).toBe(destination);
    expect(session.storageCwd).toBe(destination);
    expect(getTrackedCwd()).toBe(destination);
    expect(getSandboxSettings().enabled).toBe(true);
    expect(result.modelMessage).toContain("destination instruction");
    expect(result.modelMessage).toContain("via /cd");
  });

  it("keeps the destination when a meta recorded before the move is written after it", async () => {
    const session = new Session("relocate-pending-meta", source);
    session.pendingMeta = {
      type: "session_meta",
      ts: new Date().toISOString(),
      cwd: session.storageCwd,
      provider: "anthropic",
      model: "claude-sonnet-5",
    };

    await relocateSession(session, destination, "cd_command");
    await appendRecord(session, {
      type: "user_message",
      ts: new Date().toISOString(),
      content: "after the move",
    });

    expect(session.cwd).toBe(destination);
    expect(existsSync(sessionPathForCwd(source, session.id))).toBe(false);
    expect(readFileSync(sessionPathForCwd(destination, session.id), "utf8")).toContain(
      "after the move",
    );
  });

  it("keeps the active cwd when resumed records name an earlier storage home", () => {
    const session = new Session("relocate-resumed-meta", destination);
    session.pushRecord({
      type: "session_meta",
      ts: new Date().toISOString(),
      cwd: source,
      provider: "anthropic",
      model: "claude-sonnet-5",
    });

    expect(session.cwd).toBe(destination);
    expect(session.storageCwd).toBe(destination);
  });

  it("honors the project-memory reload gate", async () => {
    writeFileSync(join(destination, "OTHERSIDE.md"), "hidden destination instruction");
    process.env.OTHERSIDE_DISABLE_PROJECT_MEMORY = "1";
    const session = new Session("relocate-memory-gate", source);

    const result = await relocateSession(session, destination, "cd_command");

    expect(result.modelMessage).not.toContain("hidden destination instruction");
    expect(result.modelMessage).toContain("working directory has changed");
  });

  it("reports filesystem errno targets as not found", async () => {
    const loop = join(root, "loop");
    symlinkSync(loop, loop);
    expect(await pathIsDirectory(loop)).toEqual({
      ok: false,
      reason: "not_found",
      path: loop,
    });
  });
});
