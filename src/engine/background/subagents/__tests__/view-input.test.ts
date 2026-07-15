import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clear, setForkId, startTask } from "@/engine/background/tasks/background.ts";
import { loadSubagentTranscript } from "@/engine/session/transcript/subagent-transcript.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { injectQueuedUserInput } from "../fork/queued-input.ts";
import { clearAgentSteers, drainAgentSteers, pendingAgentSteerCount } from "../fork/steering.ts";
import type { ForkSpec, SidechainRecord } from "../fork/types.ts";
import { steerViewedAgent } from "../view-input.ts";

let root: string;
let previousSessionsDir: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "otherside-view-input-"));
  previousSessionsDir = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = root;
});

afterEach(async () => {
  clear();
  if (previousSessionsDir === undefined) delete process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  else process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = previousSessionsDir;
  await rm(root, { recursive: true, force: true });
});

describe("viewed agent steering", () => {
  test("persists a viewed steer only when its fork drains the queue", async () => {
    const forkId = "fork-persist-before-queue";
    const cwd = join(root, "cwd");
    const sessionId = "session-view-input";
    const task = startTask({
      parentToolCallId: "call-view-input",
      agentName: "Generalist",
      agentId: "general-purpose",
      provider: "anthropic",
      cwd,
      sessionId,
    });
    setForkId(task.id, forkId);
    clearAgentSteers(forkId);

    await steerViewedAgent({
      task: { ...task, forkId },
      sessionId,
      cwd,
      text: "must survive",
      blocks: [{ type: "text", text: "must survive" }],
    });

    expect(pendingAgentSteerCount(forkId)).toBe(1);
    expect(await loadSubagentTranscript({ cwd, sessionId, forkId })).toEqual([]);

    const fork: Message[] = [];
    const persisted: SidechainRecord[] = [];
    expect(
      injectQueuedUserInput({
        spec: { pendingUserInputDrainer: () => drainAgentSteers(forkId) } as ForkSpec,
        fork,
        ctx: { provider: "anthropic", model: "claude-test" } as RequestContext,
        appendSidechainRecord: (record) => persisted.push(record),
      }),
    ).toBe(true);

    expect(pendingAgentSteerCount(forkId)).toBe(0);
    expect(persisted).toEqual([
      expect.objectContaining({
        type: "user_message",
        content: "must survive",
        queueId: expect.any(String),
      }),
    ]);
    expect(JSON.stringify(fork)).toContain("must survive");
  });
});
