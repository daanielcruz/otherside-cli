import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowRunLedger } from "../run-ledger.ts";

async function withRunFolder(run: (folder: string) => Promise<void>): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), "otherside-run-ledger-"));
  try {
    await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

describe("WorkflowRunLedger", () => {
  it("recovers an empty index when no log exists", async () => {
    await withRunFolder(async (folder) => {
      const recovered = await new WorkflowRunLedger(join(folder, "missing")).recoverIndex();
      expect([...recovered.outputsByCacheKey]).toEqual([]);
      expect([...recovered.dispatchesByCacheKey]).toEqual([]);
      expect(recovered.runMetadata).toBeUndefined();
    });
  });

  it("indexes valid rows while ignoring blank and malformed rows", async () => {
    await withRunFolder(async (folder) => {
      const logPath = join(folder, "journal.jsonl");
      await writeFile(
        logPath,
        [
          JSON.stringify({ type: "meta", args: { generation: 1 }, scriptPath: "old.js" }),
          "not json",
          "",
          JSON.stringify({ type: "started", key: "cache-a", agentId: "agent-1" }),
          JSON.stringify({ type: "started", key: "cache-a", agentId: "agent-2" }),
          JSON.stringify({ type: "result", key: "cache-a", agentId: "agent-2", result: 1 }),
          JSON.stringify({ type: "result", key: "cache-a", agentId: "agent-3", result: 2 }),
          JSON.stringify({ type: "meta", args: null }),
          "",
        ].join("\n"),
      );

      const recovered = await new WorkflowRunLedger(folder).recoverIndex();
      expect(recovered.outputsByCacheKey.get("cache-a")?.result).toBe(2);
      expect(recovered.dispatchesByCacheKey.get("cache-a")?.map(({ agentId }) => agentId)).toEqual([
        "agent-1",
        "agent-2",
      ]);
      expect(recovered.runMetadata).toEqual({ type: "meta", args: null });
    });
  });

  it("writes compact JSON lines in call order and creates parent folders", async () => {
    await withRunFolder(async (folder) => {
      const nestedFolder = join(folder, "nested", "run");
      const ledger = new WorkflowRunLedger(nestedFolder);
      await ledger.storeRecord({ type: "started", key: "cache-a", agentId: "agent-1" });
      await ledger.storeRecord({
        type: "result",
        key: "cache-a",
        agentId: "agent-1",
        result: { answer: "yes" },
      });

      expect(await readFile(join(nestedFolder, "journal.jsonl"), "utf8")).toBe(
        '{"type":"started","key":"cache-a","agentId":"agent-1"}\n' +
          '{"type":"result","key":"cache-a","agentId":"agent-1","result":{"answer":"yes"}}\n',
      );
    });
  });

  it("retries directory preparation after a failed write", async () => {
    await withRunFolder(async (folder) => {
      const blockedParent = join(folder, "blocked");
      await writeFile(blockedParent, "not a directory");
      const ledger = new WorkflowRunLedger(join(blockedParent, "run"));
      const record = { type: "started", key: "cache-a", agentId: "agent-1" } as const;

      await expect(ledger.storeRecord(record)).rejects.toBeInstanceOf(Error);
      await rm(blockedParent);
      await ledger.storeRecord(record);

      expect(await readFile(join(blockedParent, "run", "journal.jsonl"), "utf8")).toBe(
        '{"type":"started","key":"cache-a","agentId":"agent-1"}\n',
      );
    });
  });
});
