import { describe, expect, it } from "bun:test";
import { agentTranscriptPathForCwd } from "@/engine/session/paths.ts";
import {
  enqueueWrite,
  offsetIndexForAppend,
  pendingWriteChainCount,
  rawChainFor,
  recordAppendedLine,
  releaseForkChain,
} from "../infra.ts";

describe("enqueueWrite chain reclamation", () => {
  it("drops the chain entry once the tail write settles", async () => {
    const path = "/tmp/otherside-chain-reclaim/session.jsonl";
    const order: number[] = [];

    const first = enqueueWrite(path, async () => {
      order.push(1);
    });
    const second = enqueueWrite(path, async () => {
      order.push(2);
    });
    await Promise.all([first, second]);
    // The settle-hook runs a microtask after the tail resolves.
    await Promise.resolve();

    expect(order).toEqual([1, 2]);
    expect(pendingWriteChainCount()).toBe(0);

    let ran = false;
    await enqueueWrite(path, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("keeps the entry while a newer write is still chained", async () => {
    const path = "/tmp/otherside-chain-live/session.jsonl";
    let releaseFirst: (() => void) | undefined;
    const first = enqueueWrite(
      path,
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const second = enqueueWrite(path, async () => {});

    expect(pendingWriteChainCount()).toBeGreaterThan(0);

    // The chained task factory only runs after the prior link's microtask.
    while (releaseFirst === undefined) await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);
    await Promise.resolve();
    expect(pendingWriteChainCount()).toBe(0);
  });
});

describe("releaseForkChain", () => {
  it("drops the raw fork chain", () => {
    const sessionId = "session-release-raw";
    const agentId = "fork-release-raw";
    const cwd = "/tmp/otherside-release-raw";
    const before = rawChainFor(`${sessionId}/${agentId}`);

    releaseForkChain(sessionId, agentId, cwd);

    expect(rawChainFor(`${sessionId}/${agentId}`)).not.toBe(before);
  });

  it("drops queued writes for the fork transcript path", async () => {
    const sessionId = "session-release-write";
    const agentId = "fork-release-write";
    const cwd = "/tmp/otherside-release-write";
    const path = agentTranscriptPathForCwd(cwd, sessionId, agentId);
    let releaseFirstWrite!: () => void;
    let secondWriteRan = false;

    const firstWrite = enqueueWrite(
      path,
      () =>
        new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        }),
    );

    releaseForkChain(sessionId, agentId, cwd);

    const secondWrite = enqueueWrite(path, async () => {
      secondWriteRan = true;
    });
    await secondWrite;

    expect(secondWriteRan).toBe(true);

    releaseFirstWrite();
    await firstWrite;
    releaseForkChain(sessionId, agentId, cwd);
  });

  it("invalidates the fork transcript offset index", async () => {
    const sessionId = "session-release-offset";
    const agentId = "fork-release-offset";
    const cwd = "/tmp/otherside-release-offset";
    const path = agentTranscriptPathForCwd(cwd, sessionId, agentId);

    const index = await offsetIndexForAppend(path);
    recordAppendedLine(index, "uuid-1", 100);
    expect(index.byUuid.has("uuid-1")).toBe(true);
    // Same cached instance until invalidated.
    expect(await offsetIndexForAppend(path)).toBe(index);

    releaseForkChain(sessionId, agentId, cwd);

    const fresh = await offsetIndexForAppend(path);
    expect(fresh).not.toBe(index);
    expect(fresh.byUuid.size).toBe(0);
  });
});
