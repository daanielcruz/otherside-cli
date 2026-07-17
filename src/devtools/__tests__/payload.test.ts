import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { recordPayloadDiagnostic } from "@/devtools/payload.ts";
import { type DispatchEntry, settleDispatch } from "@/engine/queue/runtime/turn/tool-dispatch.ts";
import type { TurnLoopHost } from "@/engine/queue/runtime/turn/types.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import { AsyncStream } from "@/kernel/std/stream/async.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";

const roots: string[] = [];
const savedPath = process.env.OTHERSIDE_PAYLOAD_DIAG;
const savedToolResultsPath = process.env.OTHERSIDE_TOOL_RESULTS_DIR;

afterEach(() => {
  if (savedPath === undefined) delete process.env.OTHERSIDE_PAYLOAD_DIAG;
  else process.env.OTHERSIDE_PAYLOAD_DIAG = savedPath;
  if (savedToolResultsPath === undefined) delete process.env.OTHERSIDE_TOOL_RESULTS_DIR;
  else process.env.OTHERSIDE_TOOL_RESULTS_DIR = savedToolResultsPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("payload diagnostics", () => {
  it("records payload sizes without recording payload content", () => {
    const root = mkdtempSync(join(process.cwd(), ".mcp-payload-test-"));
    roots.push(root);
    const path = join(root, "payload.jsonl");
    process.env.OTHERSIDE_PAYLOAD_DIAG = path;
    const text = "é".repeat(4_096);
    const context = {
      serverName: "fixture",
      toolName: "large_result",
      toolUseId: "call-1",
    };

    recordPayloadDiagnostic("mcp-transport-result", { content: [{ type: "text", text }] }, context);
    recordPayloadDiagnostic("mcp-returned-result", "saved to fixture", context);

    const records = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      stage: "mcp-transport-result",
      ...context,
      stringBytes: Buffer.byteLength("text", "utf8") + Buffer.byteLength(text, "utf8"),
      largestStringBytes: Buffer.byteLength(text, "utf8"),
    });
    expect(records[1]).toMatchObject({
      stage: "mcp-returned-result",
      ...context,
      stringBytes: Buffer.byteLength("saved to fixture", "utf8"),
    });
    expect(readFileSync(path, "utf8")).not.toContain(text);
  });

  it("records raw and persisted tool-result boundaries", async () => {
    const root = mkdtempSync(join(process.cwd(), ".tool-payload-test-"));
    roots.push(root);
    const path = join(root, "payload.jsonl");
    process.env.OTHERSIDE_PAYLOAD_DIAG = path;
    process.env.OTHERSIDE_TOOL_RESULTS_DIR = join(root, "tool-results");
    const content = "x".repeat(60_000);
    const entry: DispatchEntry = {
      call: { id: "call-raw", name: "Bash", input: { command: "fixture" } },
      queue: new AsyncStream<AgentEvent>(),
      abortController: new AbortController(),
      isAgentTool: false,
      isBackgroundable: false,
      bgTaskId: undefined,
      flags: { backgrounded: false, dispatchDone: true, settled: false },
      backgroundPromise: Promise.resolve(),
      dispatchPromise: Promise.resolve({ tool_use_id: "call-raw", content }),
      outcome: Promise.resolve({ kind: "failed", error: null }),
    };
    const host: TurnLoopHost = {
      cancelled: false,
      currentTurnId: null,
      activeAbortController: null,
      activeToolAbortControllers: new Set<AbortController>(),
      injections: makeQueue(),
      deps: {
        session: { id: "test", cwd: process.cwd(), messages: [], records: [] } as never,
        broker: {} as never,
        config: {} as never,
      },
      compactState: {
        rapidRefillBreakerOpen: false,
        rapidRefillCount: 0,
        consecutiveCompactFailures: 0,
        turnsSinceLast: Number.POSITIVE_INFINITY,
        lastAutoCompactAttemptTurnId: null,
      },
      sessionAllowedToolPatterns: new Set<string>(),
      loadedNestedMemoryPaths: new Set<string>(),
      nestedMemoryByPath: new Map<string, string>(),
      pendingUserInputDrainer: null,
      cancel: () => {},
      getNestedMemorySnapshot: () => [],
    };

    const outcome = await settleDispatch(host, entry);

    expect(outcome.kind).toBe("completed");
    const records = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      stage: "tool-handler-result",
      toolName: "Bash",
      toolUseId: "call-raw",
      stringBytes: content.length,
      largestStringBytes: content.length,
    });
    expect(records[1]).toMatchObject({
      stage: "tool-persisted-result",
      toolName: "Bash",
      toolUseId: "call-raw",
    });
    expect(records[1].stringBytes).toBeLessThan(content.length);
    expect(readFileSync(path, "utf8")).not.toContain(content);
  });
});
