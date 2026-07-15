import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTranscriptPathForCwd } from "@/engine/session/paths.ts";
import { appendAgentRecordRaw } from "@/engine/session/persist.ts";
import { nowIso } from "@/engine/session/record/index.ts";
import { loadSubagentTranscript } from "../transcript/subagent-transcript.ts";

let root: string;
let previous: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "otherside-subagent-transcript-"));
  previous = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = root;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  else process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = previous;
  await rm(root, { recursive: true, force: true });
});

describe("subagent transcript helpers", () => {
  test("reconstructs records from a sidechain transcript with isSidechain stripped", async () => {
    const ref = { cwd: join(root, "cwd"), sessionId: "s1", agentId: "fork1" };
    await appendAgentRecordRaw(ref, {
      type: "user_message",
      ts: nowIso(),
      content: "hello",
      provider: "anthropic",
      model: "claude-test",
      isSidechain: true,
    });
    await appendAgentRecordRaw(ref, {
      type: "assistant_message",
      ts: nowIso(),
      content: "hi",
      provider: "anthropic",
      model: "claude-test",
      isSidechain: true,
    });
    await appendAgentRecordRaw(ref, {
      type: "content_replacement",
      ts: nowIso(),
      kind: "tool-result",
      toolUseId: "tool-1",
      replacement: "frozen result",
      isSidechain: true,
    });

    const records = await loadSubagentTranscript({
      cwd: ref.cwd,
      sessionId: ref.sessionId,
      forkId: ref.agentId,
    });
    expect(records.map((record) => record.type)).toEqual([
      "user_message",
      "assistant_message",
      "content_replacement",
    ]);
    for (const record of records) {
      if ("isSidechain" in record) expect(record.isSidechain).not.toBe(true);
    }
    const replacement = records[2];
    if (replacement?.type !== "content_replacement") throw new Error("wrong record type");
    expect(replacement.toolUseId).toBe("tool-1");
    expect(replacement.replacement).toBe("frozen result");
  });

  test("threads parentUuid through the per-fork chain (first line null, rest linked)", async () => {
    const ref = { cwd: join(root, "cwd"), sessionId: "thread-s", agentId: "thread-fork" };
    await appendAgentRecordRaw(ref, {
      type: "user_message",
      ts: nowIso(),
      content: "a",
      provider: "anthropic",
      model: "claude-test",
      isSidechain: true,
    });
    await appendAgentRecordRaw(ref, {
      type: "assistant_message",
      ts: nowIso(),
      content: "b",
      provider: "anthropic",
      model: "claude-test",
      isSidechain: true,
    });

    const path = agentTranscriptPathForCwd(ref.cwd, ref.sessionId, ref.agentId);
    const lines = (await Bun.file(path).text())
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map(
        (line) =>
          JSON.parse(line) as { uuid: string; parentUuid: string | null; isSidechain?: boolean },
      );

    expect(lines).toHaveLength(2);
    expect(lines[0]?.isSidechain).toBe(true);
    expect(lines[0]?.parentUuid).toBeNull();
    expect(typeof lines[0]?.uuid).toBe("string");
    expect(lines[1]?.parentUuid).toBe(lines[0]?.uuid ?? "");
  });
});
