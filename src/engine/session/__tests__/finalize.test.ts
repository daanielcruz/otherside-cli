import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create, get } from "@/engine/background/tasks/index.ts";
import { readSetContains, readSetInsert } from "@/engine/tools/builtins/read/state.ts";
import { getAssembledTurn, setAssembledTurn } from "@/engine/translator/assembled.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import {
  clientFor,
  closeAllClients,
  setMcpClientSpawnerForTests,
} from "@/kernel/mcp/client/registry.ts";
import type { McpClient, McpResourceInfo, McpToolInfo } from "@/kernel/mcp/protocol/types.ts";
import { finalizeSession, hasSessionTranscript } from "../finalize.ts";
import { sessionPathForCwd } from "../paths.ts";
import { Session } from "../record/index.ts";

const EMPTY_HARNESS: ComposedHarness = {
  layers: [],
  combined: "",
  systemBlocks: [],
  userPrepend: [],
  midSystemPromotion: "off",
};

class FakeMcpClient implements McpClient {
  private closed = false;

  async listTools(): Promise<McpToolInfo[]> {
    return [];
  }

  async callTool(): Promise<unknown> {
    return null;
  }

  async listResources(): Promise<McpResourceInfo[]> {
    return [];
  }

  async readResource(): Promise<unknown> {
    return null;
  }

  async listDirectory() {
    return { resources: [] };
  }

  serverCapabilities() {
    return null;
  }

  serverInstructions(): string | null {
    return null;
  }

  async listPrompts() {
    return [];
  }

  async getPrompt() {
    return { messages: [] };
  }

  announce(): void {}

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }
}

let base: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-finalize-test-"));
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
});

afterEach(async () => {
  await closeAllClients();
  setMcpClientSpawnerForTests(null);
  if (savedConfigDir === undefined) {
    delete process.env.OTHERSIDE_CONFIG_DIR;
  } else {
    process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  }
  rmSync(base, { recursive: true, force: true });
});

describe("finalizeSession", () => {
  it("recognizes a recorded transcript without in-memory messages", () => {
    const s = new Session("recorded-session", base);
    const path = sessionPathForCwd(s.storageCwd, s.id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"type":"session_meta"}\n', "utf8");

    expect(s.records).toEqual([]);
    expect(hasSessionTranscript(s)).toBe(true);
  });

  it("flushes pendingMeta if session is non-empty and has message records", async () => {
    const s = new Session("session-1", base);
    s.pushRecord({
      type: "user_message",
      ts: new Date().toISOString(),
      content: "hello world",
    });
    s.pendingMeta = {
      type: "session_meta",
      ts: new Date().toISOString(),
      cwd: base,
      provider: "openai",
      model: "gpt-4o",
      effort: "medium",
      fastMode: true,
    };

    await finalizeSession(s);

    expect(s.pendingMeta).toBeNull();
    expect(s.records.length).toBe(2);
    const metaRecord = s.records[1];
    if (metaRecord?.type !== "session_meta") throw new Error("expected session_meta record");
    expect(metaRecord.provider).toBe("openai");

    const path = sessionPathForCwd(s.cwd, s.id);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("otherside-config");
    expect(content).toContain("openai");
    expect(content).toContain("last-prompt");
  });

  it("does not write duplicate session_meta when the last record matches", async () => {
    const s = new Session("session-2", base);
    s.pushRecord({
      type: "user_message",
      ts: new Date().toISOString(),
      content: "hello world",
    });
    const meta = {
      type: "session_meta" as const,
      ts: new Date().toISOString(),
      cwd: base,
      provider: "openai",
      model: "gpt-4o",
      effort: "medium",
      fastMode: true,
    };
    s.pushRecord(meta);
    s.pendingMeta = {
      type: "session_meta",
      ts: new Date().toISOString(),
      cwd: base,
      provider: "openai",
      model: "gpt-4o",
      effort: "medium",
      fastMode: true,
    };

    await finalizeSession(s);

    expect(s.pendingMeta).toBeNull();
    expect(s.records.length).toBe(2);

    const path = sessionPathForCwd(s.cwd, s.id);
    expect(existsSync(path)).toBe(true);
  });

  it("does not write duplicate session_meta when pendingMeta is null", async () => {
    const s = new Session("session-3", base);
    s.pushRecord({
      type: "user_message",
      ts: new Date().toISOString(),
      content: "hello world",
    });
    s.pendingMeta = null;

    await finalizeSession(s);

    expect(s.pendingMeta).toBeNull();
    expect(s.records.length).toBe(1);
  });

  it("does not preserve empty session clutter", async () => {
    const s = new Session("session-4", base);
    s.pendingMeta = {
      type: "session_meta",
      ts: new Date().toISOString(),
      cwd: base,
      provider: "openai",
      model: "gpt-4o",
      effort: "medium",
      fastMode: true,
    };

    await finalizeSession(s);

    expect(s.records.length).toBe(0);
    const path = sessionPathForCwd(s.cwd, s.id);
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a recorded transcript whose message records are only on disk", async () => {
    const s = new Session("session-4b", base);
    const path = sessionPathForCwd(s.storageCwd, s.id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user_message", ts: new Date().toISOString(), content: "hi" })}\n`,
      "utf8",
    );

    await finalizeSession(s);

    expect(existsSync(path)).toBe(true);
  });

  it("keeps a transcript past the head budget without parsing it", async () => {
    const s = new Session("session-4c", base);
    const path = sessionPathForCwd(s.storageCwd, s.id);
    mkdirSync(dirname(path), { recursive: true });
    // No message record anywhere, but the file is larger than the head budget.
    const filler = `${JSON.stringify({ type: "system", subtype: "noise", pad: "x".repeat(4096) })}\n`;
    writeFileSync(path, filler.repeat(Math.ceil((64 * 1024 + 1) / filler.length)), "utf8");
    expect(statSync(path).size).toBeGreaterThan(64 * 1024);

    await finalizeSession(s);

    expect(existsSync(path)).toBe(true);
  });

  it("drops a sub-head-budget transcript with no message records", async () => {
    const s = new Session("session-4d", base);
    const path = sessionPathForCwd(s.storageCwd, s.id);
    mkdirSync(dirname(path), { recursive: true });
    const filler = `${JSON.stringify({ type: "system", subtype: "noise", pad: "x".repeat(1024) })}\n`;
    writeFileSync(path, filler.repeat(8), "utf8");
    expect(statSync(path).size).toBeLessThan(64 * 1024);

    await finalizeSession(s);

    expect(existsSync(path)).toBe(false);
  });

  it("cleans up heap maps on session finalization", async () => {
    const s = new Session("session-5", base);
    s.pushRecord({
      type: "user_message",
      ts: new Date().toISOString(),
      content: "hello world",
    });

    readSetInsert("session-5", "test-file.txt", "content");
    setAssembledTurn("session-5", { harness: EMPTY_HARNESS, tools: [] });
    create({ subject: "task 1", description: "desc" }, "session-5");

    expect(readSetContains("session-5", "test-file.txt")).toBe(true);
    expect(getAssembledTurn("session-5")).toBeDefined();
    expect(get("1", "session-5")).toBeDefined();
    const taskDir = join(base, "config", "tasks", "session-5");
    expect(existsSync(taskDir)).toBe(true);

    await finalizeSession(s);

    expect(readSetContains("session-5", "test-file.txt")).toBe(false);
    expect(getAssembledTurn("session-5")).toBeUndefined();
    // The task list survives session end on disk (age-based retention and the
    // all-complete reset own its cleanup); a later read re-hydrates it, which
    // is what lets a resumed session show its tasks again.
    expect(existsSync(taskDir)).toBe(true);
    expect(get("1", "session-5")).toBeDefined();
  });

  it("cleans up heap maps even for empty session finalization", async () => {
    const s = new Session("session-6", base);

    readSetInsert("session-6", "test-file.txt", "content");
    setAssembledTurn("session-6", { harness: EMPTY_HARNESS, tools: [] });
    create({ subject: "task 1", description: "desc" }, "session-6");

    expect(readSetContains("session-6", "test-file.txt")).toBe(true);
    expect(getAssembledTurn("session-6")).toBeDefined();
    expect(get("1", "session-6")).toBeDefined();
    const taskDir = join(base, "config", "tasks", "session-6");
    expect(existsSync(taskDir)).toBe(true);

    await finalizeSession(s);

    expect(readSetContains("session-6", "test-file.txt")).toBe(false);
    expect(getAssembledTurn("session-6")).toBeUndefined();
    expect(existsSync(taskDir)).toBe(true);
    expect(get("1", "session-6")).toBeDefined();
  });

  it("closes cached MCP clients on session finalization", async () => {
    const client = new FakeMcpClient();
    setMcpClientSpawnerForTests(async () => client);
    await clientFor("playwright", { type: "stdio", command: "mcp-server", args: [] });
    const s = new Session("session-7", base);

    await finalizeSession(s);
    await Promise.resolve();

    expect(client.isClosed()).toBe(true);
  });
});
