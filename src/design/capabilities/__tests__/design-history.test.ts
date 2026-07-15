import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesignHistory } from "@/design/history.ts";
import { designStorageDir, loadDesignSnapshot } from "@/design/storage.ts";
import type { DesignSnapshot, PersistedToolCard } from "@/design/types.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

function makeSnapshot(tools: PersistedToolCard[]): DesignSnapshot {
  return {
    designId: "design-1",
    messages: [],
    files: [],
    artifacts: [],
    tools,
    viewState: { activeFileTab: null, openFiles: [], activeChatId: null },
    designSystem: { designSystemId: "default", isDefault: true },
    status: "completed",
    updatedAt: new Date().toISOString(),
  };
}

function blockTypes(blocks: ContentBlock[]): string[] {
  return blocks.map((block) => block.type);
}

describe("buildDesignHistory — structured replay of prior turns", () => {
  it("replays a turn with tools as user → tool_use → tool_result → assistant", () => {
    const snapshot = makeSnapshot([
      {
        id: "t1",
        name: "create_design",
        phase: "done",
        toolUseId: "t1",
        input: JSON.stringify({ path: "home.os.html" }),
        output: "Created home.os.html",
        isError: false,
        turnIndex: 0,
      },
      {
        id: "t2",
        name: "read_design",
        phase: "error",
        toolUseId: "t2",
        input: "{not valid json",
        isError: true,
        turnIndex: 0,
      },
    ]);
    const history = buildDesignHistory(snapshot, [
      { role: "user", content: "make a page" },
      { role: "assistant", content: "done!" },
    ]);

    expect(history).toHaveLength(4);
    expect(history[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "make a page" }],
    });

    const toolUseMsg = history[1];
    expect(toolUseMsg?.role).toBe("assistant");
    expect(blockTypes(toolUseMsg?.content ?? [])).toEqual(["tool_use", "tool_use"]);
    expect(toolUseMsg?.content[0]).toEqual({
      type: "tool_use",
      id: "t1",
      name: "create_design",
      input: { path: "home.os.html" },
    });
    // Unparseable (truncated) persisted input degrades to {}.
    expect(toolUseMsg?.content[1]).toEqual({
      type: "tool_use",
      id: "t2",
      name: "read_design",
      input: {},
    });

    const toolResultMsg = history[2];
    expect(toolResultMsg?.role).toBe("user");
    expect(toolResultMsg?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: "Created home.os.html",
    });
    expect(toolResultMsg?.content[1]).toEqual({
      type: "tool_result",
      tool_use_id: "t2",
      content: "(result not recorded)",
      is_error: true,
    });

    expect(history[3]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "done!" }],
    });
  });

  it("replays a turn without tools as plain user/assistant text", () => {
    const history = buildDesignHistory(makeSnapshot([]), [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    expect(history).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ]);
  });

  it("drops the oldest turns' tool blocks first when over the cap", () => {
    const bigOutput = "x".repeat(1000);
    const tools: PersistedToolCard[] = [0, 1, 2].map((turn) => ({
      id: `t${turn}`,
      name: "update_design",
      phase: "done" as const,
      toolUseId: `t${turn}`,
      input: JSON.stringify({ path: `screen-${turn}.os.html` }),
      output: bigOutput,
      turnIndex: turn,
    }));
    const messages = [0, 1, 2].flatMap((turn) => [
      { role: "user", content: `request ${turn}` },
      { role: "assistant", content: `reply ${turn}` },
    ]);
    const snapshot = makeSnapshot(tools);

    const fullSize = JSON.stringify(buildDesignHistory(snapshot, messages)).length;
    // A cap just below full size: degrading only turn 0 to text should suffice.
    const history = buildDesignHistory(snapshot, messages, fullSize - 100);

    const ids = history
      .flatMap((message) => message.content)
      .filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => {
        return block.type === "tool_use";
      })
      .map((block) => block.id);
    expect(ids).toEqual(["t1", "t2"]);
    // Turn 0's text survives even though its tool blocks were dropped.
    expect(JSON.stringify(history)).toContain("request 0");
    expect(JSON.stringify(history)).toContain("reply 0");
  });

  it("drops oldest whole turns next, but never the most recent 2 turns' structure", () => {
    const tools: PersistedToolCard[] = [0, 1, 2].map((turn) => ({
      id: `t${turn}`,
      name: "update_design",
      phase: "done" as const,
      toolUseId: `t${turn}`,
      input: "{}",
      output: "y".repeat(500),
      turnIndex: turn,
    }));
    const messages = [0, 1, 2].flatMap((turn) => [
      { role: "user", content: `request ${turn}` },
      { role: "assistant", content: `reply ${turn}` },
    ]);

    // Impossibly small cap: only turn 0 is trimmable — the last two turns keep
    // their full tool structure even though the result still exceeds the cap.
    const history = buildDesignHistory(makeSnapshot(tools), messages, 10);

    expect(JSON.stringify(history)).not.toContain("request 0");
    const ids = history
      .flatMap((message) => message.content)
      .filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => {
        return block.type === "tool_use";
      })
      .map((block) => block.id);
    expect(ids).toEqual(["t1", "t2"]);
  });

  it("treats tool cards without a turnIndex (old snapshots) as text-only history", () => {
    const snapshot = makeSnapshot([
      { id: "old-1", name: "update_todos", phase: "done", preview: { todos: [] } },
    ]);
    const history = buildDesignHistory(snapshot, [
      { role: "user", content: "old request" },
      { role: "assistant", content: "old reply" },
    ]);
    expect(history).toEqual([
      { role: "user", content: [{ type: "text", text: "old request" }] },
      { role: "assistant", content: [{ type: "text", text: "old reply" }] },
    ]);
  });
});

describe("loadDesignSnapshot — pre-structured-history snapshots", () => {
  let tempConfigDir: string;
  let originalConfigDir: string | undefined;
  const cwd = "/Users/testuser/project";

  beforeEach(() => {
    originalConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "otherside-test-config-"));
    process.env.OTHERSIDE_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (originalConfigDir !== undefined) {
      process.env.OTHERSIDE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.OTHERSIDE_CONFIG_DIR;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  it("loads an old snapshot whose tool cards lack the new fields", () => {
    const designId = "legacy-design";
    const dir = designStorageDir(cwd, designId);
    mkdirSync(dir, { recursive: true });
    const legacy = {
      designId,
      messages: [
        {
          id: "m-1",
          role: "user",
          content: "hello",
          createdAt: "2024-01-01T00:00:00.000Z",
          source: "left",
          status: "done",
        },
      ],
      files: [],
      artifacts: [],
      tools: [{ id: "t-1", name: "create_design", phase: "done" }],
      viewState: { activeFileTab: null, openFiles: [], activeChatId: null },
      designSystem: { designSystemId: "default", isDefault: true },
      status: "completed",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify(legacy));

    const loaded = loadDesignSnapshot(cwd, designId);
    expect(loaded).not.toBeNull();
    expect(loaded?.tools).toEqual([{ id: "t-1", name: "create_design", phase: "done" }]);
    expect(loaded?.tools?.[0]?.toolUseId).toBeUndefined();
    expect(loaded?.tools?.[0]?.turnIndex).toBeUndefined();
    expect(loaded?.messages[0]?.turnIndex).toBeUndefined();
  });
});
