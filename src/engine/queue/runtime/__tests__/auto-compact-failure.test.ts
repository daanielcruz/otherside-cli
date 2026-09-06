import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Provider } from "@/engine/contract/types.ts";
import { registerRuntimeModel, resetRuntimeModelsForTests } from "@/engine/model/catalog.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import * as providers from "@/engine/providers/registry.ts";
import { maybeCompact } from "@/engine/queue/runtime/compact/auto.ts";
import { forceCompact } from "@/engine/queue/runtime/compact/manual.ts";
import type {
  CompactOrchestrationDeps,
  CompactState,
} from "@/engine/queue/runtime/compact/support.ts";
import { clearLastUsage, getLastUsage, setLastUsage } from "@/engine/session/compact/last-usage.ts";
import { sessionPathForCwd } from "@/engine/session/paths.ts";
import { loadSessionForResume, readActiveChainLines } from "@/engine/session/reader.ts";
import {
  isCompactionBoundary,
  Session,
  SessionChain,
  type SessionRecord,
  serializeRecord,
} from "@/engine/session/record/index.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import { assembleProviderTurn } from "@/engine/translator/index.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import type { AgentEvent, ProviderEvent } from "@/kernel/std/types/events.ts";

registerAllProviders();

const MODEL = "compact-failure-test";
const TS = "2026-01-01T00:00:00.000Z";
const originalXai = providers.get("xai");
const savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
const savedToolResultsDir = process.env.OTHERSIDE_TOOL_RESULTS_DIR;

type ProviderMode = "refusal" | "quota" | "cancelled" | "short" | "success";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-compact-state-"));
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
  process.env.OTHERSIDE_TOOL_RESULTS_DIR = join(base, "tool-results");
  clearLastUsage();
  registerRuntimeModel({
    id: MODEL,
    displayName: "Compact failure test",
    contextWindow: 200_000,
    autoCompactTokenLimit: 100_000,
    provider: "xai",
    efforts: ["high"],
    defaultEffort: "high",
  });
});

afterEach(() => {
  providers.register(originalXai);
  resetRuntimeModelsForTests();
  clearLastUsage();
  restoreEnv("OTHERSIDE_CONFIG_DIR", savedConfigDir);
  restoreEnv("OTHERSIDE_TOOL_RESULTS_DIR", savedToolResultsDir);
  rmSync(base, { recursive: true, force: true });
});

describe("auto compact failure state", () => {
  it("surfaces terminal failures without mutating conversation state", async () => {
    for (const mode of ["refusal", "quota", "cancelled", "short"] as const) {
      const bodies: unknown[] = [];
      providers.register(makeProvider(mode, bodies));
      const { deps, session, injections } = makeDeps(`submission-${mode}`);
      injections.push("existing injection");
      persistSessionRecords(session);
      const before = snapshot(session, injections.peek());

      const events = await collect(maybeCompact(deps));

      expect(events.some((event) => event.kind === "compact_done")).toBe(true);
      const done = events.find((event) => event.kind === "compact_done");
      expect(done?.mode).toBe("failed");
      expect(events.some((event) => event.kind === "error")).toBe(false);
      expect(events.some((event) => event.kind === "quota_exhausted")).toBe(false);
      expect(snapshot(session, injections.peek())).toEqual(before);
      expect(serializedBoundaryCount(session.records, session)).toBe(0);
      const stored = readFileSync(sessionPathForCwd(session.storageCwd, session.id), "utf8");
      expect(stored).not.toContain("compact_boundary");
      const resumed = await loadSessionForResume(session.id, session.cwd);
      expect(resumed.records.some((record) => record.type === "compaction_mark")).toBe(false);
      expect(JSON.stringify(events)).not.toContain("disabled for this session");
      expect(bodies).toHaveLength(1);
    }
  });

  it("attempts once per submission and retries on every fresh submission", async () => {
    const bodies: unknown[] = [];
    providers.register(makeProvider("refusal", bodies));
    const { deps, session, injections } = makeDeps("submission-1");
    const before = snapshot(session, injections.peek());

    const first = await collect(maybeCompact(deps));
    const duplicate = await collect(maybeCompact(deps));
    expect(first.some((event) => event.kind === "compact_start")).toBe(true);
    expect(first.find((event) => event.kind === "compact_done")?.mode).toBe("failed");
    expect(duplicate).toEqual([]);
    expect(bodies).toHaveLength(1);

    for (const turnId of ["submission-2", "submission-3", "submission-4"]) {
      deps.turnId = turnId;
      const events = await collect(maybeCompact(deps));
      expect(events.some((event) => event.kind === "compact_start")).toBe(true);
      expect(events.find((event) => event.kind === "compact_done")?.mode).toBe("failed");
    }

    expect(bodies).toHaveLength(4);
    const provider = providers.get("xai");
    const nextTurn = assembleProviderTurn({
      ctx: deps.makeCtx(),
      provider,
      messages: session.messages,
      injections,
      config: deps.agentDeps.config,
    });
    const nextBody = provider.translateRequest(deps.makeCtx(), nextTurn.messages, nextTurn.tools);
    expect(JSON.stringify(nextBody)).not.toContain("auto-compact failed");
    expect(JSON.stringify(nextBody)).not.toContain("disabled for this session");
    expect(snapshot(session, injections.peek())).toEqual(before);
    expect(serializedBoundaryCount(session.records, session)).toBe(0);
  });

  it("keeps the rapid-refill guard private to compact state", async () => {
    const bodies: unknown[] = [];
    providers.register(makeProvider("success", bodies));
    const { deps, session, injections } = makeDeps("rapid-refill");
    deps.state.turnsSinceLast = 0;
    deps.state.rapidRefillCount = 2;
    const before = snapshot(session, injections.peek());

    const events = await collect(maybeCompact(deps));

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("compact_done");
    expect(events[0]?.kind === "compact_done" ? events[0].mode : null).toBe("failed");
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(deps.state.rapidRefillBreakerOpen).toBe(true);
    expect(snapshot(session, injections.peek())).toEqual(before);
    expect(serializedBoundaryCount(session.records, session)).toBe(0);
    expect(bodies).toHaveLength(0);
  });

  it("opens the failure breaker after three consecutive summarization failures", async () => {
    const bodies: unknown[] = [];
    providers.register(makeProvider("refusal", bodies));
    const { deps } = makeDeps("breaker-turn-0");
    for (const [index, turnId] of [
      "breaker-turn-1",
      "breaker-turn-2",
      "breaker-turn-3",
    ].entries()) {
      deps.turnId = turnId;
      deps.state.turnsSinceLast = 4;
      const events = await collect(maybeCompact(deps));
      expect(events.find((event) => event.kind === "compact_done")?.mode).toBe("failed");
      expect(deps.state.consecutiveCompactFailures).toBe(index + 1);
    }
    expect(bodies).toHaveLength(3);

    // Breaker open + rapid refill: the attempt is skipped without any event.
    deps.turnId = "breaker-turn-4";
    deps.state.turnsSinceLast = 0;
    expect(await collect(maybeCompact(deps))).toEqual([]);
    expect(bodies).toHaveLength(3);
    expect(deps.state.consecutiveCompactFailures).toBe(3);
  });

  it("re-arms the failure breaker after a slow refill and compacts again", async () => {
    const bodies: unknown[] = [];
    providers.register(makeProvider("success", bodies));
    const { deps, session } = makeDeps("rearm-turn-1");
    persistSessionRecords(session);
    deps.state.consecutiveCompactFailures = 3;
    deps.state.turnsSinceLast = 4;

    const events = await collect(maybeCompact(deps));

    expect(events.some((event) => event.kind === "compact_start")).toBe(true);
    expect(events.find((event) => event.kind === "compact_done")?.mode).toBe("summary");
    expect(deps.state.consecutiveCompactFailures).toBe(0);
    expect(bodies).toHaveLength(1);
  });

  it("resets the failure counter on a successful compact between failures", async () => {
    const bodies: unknown[] = [];
    providers.register(makeProvider("refusal", bodies));
    const { deps, session } = makeDeps("reset-turn-1");
    persistSessionRecords(session);
    deps.state.turnsSinceLast = 4;
    await collect(maybeCompact(deps));
    expect(deps.state.consecutiveCompactFailures).toBe(1);

    providers.register(makeProvider("success", bodies));
    deps.turnId = "reset-turn-2";
    deps.state.turnsSinceLast = 4;
    const events = await collect(maybeCompact(deps));

    expect(events.find((event) => event.kind === "compact_done")?.mode).toBe("summary");
    expect(deps.state.consecutiveCompactFailures).toBe(0);
  });

  it("writes exactly one boundary after a successful summary", async () => {
    const bodies: unknown[] = [];
    providers.register(makeProvider("success", bodies));
    const { deps, session } = makeDeps("successful-submission");
    persistSessionRecords(session);

    const events = await collect(maybeCompact(deps));

    const done = events.find((event) => event.kind === "compact_done");
    expect(done?.mode).toBe("summary");
    expect(session.records).toHaveLength(1);
    const boundary = session.records[0];
    expect(boundary?.type).toBe("compaction_mark");
    expect(boundary?.type === "compaction_mark" && isCompactionBoundary(boundary)).toBe(true);
    expect(serializedBoundaryCount(session.records, session)).toBe(1);
    const stored = readFileSync(sessionPathForCwd(session.storageCwd, session.id), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(stored.filter((line) => line.subtype === "compact_boundary")).toHaveLength(1);
    const resumed = await loadSessionForResume(session.id, session.cwd);
    // Resume projects the model-facing chain through modelRecords (boundary
    // summary + preserved tail). Raw records keep pre-boundary history and
    // sessionRecordsToMessages alone would drop the tail at the boundary.
    const resumedText = sessionRecordsToMessages(resumed.modelRecords).flatMap((message) =>
      message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    );
    expect(resumedText).toContain("latest assistant");
  });

  /**
   * The preserve chain round-trip: the boundary the auto-compact writes names
   * itself (uuid) and the preserved tail in both metadata forms, and the resume
   * chain read validates that metadata and relinks anchor → head → tail so the
   * preserved rows hang off the boundary instead of the replaced history.
   */
  it("writes the preserve chain on the boundary and the resume read relinks it", async () => {
    const bodies: unknown[] = [];
    providers.register(makeProvider("success", bodies));
    const { deps, session } = makeDeps("preserve-chain-submission");
    persistSessionRecords(session);

    const events = await collect(maybeCompact(deps));
    expect(events.find((event) => event.kind === "compact_done")?.mode).toBe("summary");

    const stored = readFileSync(sessionPathForCwd(session.storageCwd, session.id), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const boundary = stored.find((line) => line.subtype === "compact_boundary");
    expect(boundary).toBeDefined();
    const boundaryUuid = boundary?.uuid;
    expect(typeof boundaryUuid).toBe("string");
    const metadata = boundary?.compactMetadata as {
      preservedSegment?: { headUuid: string; tailUuid: string; anchorUuid: string };
      preservedMessages?: { uuids: string[]; anchorUuid: string };
    };
    // An api round starts at an assistant id, so the preserved group is the
    // final assistant message alone.
    expect(metadata.preservedSegment).toEqual({
      headUuid: "assistant-2",
      tailUuid: "assistant-2",
      anchorUuid: boundaryUuid as string,
    });
    expect(metadata.preservedMessages).toEqual({
      uuids: ["assistant-2"],
      anchorUuid: boundaryUuid as string,
    });

    const chainLines = (await readActiveChainLines(session.id)).map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const parentOf = (uuid: string): unknown =>
      chainLines.find((line) => line.uuid === uuid)?.parentUuid;
    expect(parentOf("assistant-2")).toBe(boundaryUuid);
  });

  it("keeps explicit compact retryable after repeated invalid summaries", async () => {
    const bodies: unknown[] = [];
    providers.register(makeProvider("short", bodies));
    const { deps, session, injections } = makeDeps("manual-submission");
    const before = snapshot(session, injections.peek());
    const outcomes: { mode: string; error?: string }[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        forceCompact(deps, {
          onCompactDone: (info) =>
            outcomes.push({
              mode: info.mode,
              ...(info.error !== undefined ? { error: info.error } : {}),
            }),
        }),
      ).rejects.toThrow("generated summary is empty or too short");
    }

    expect(outcomes.map((outcome) => outcome.mode)).toEqual(["failed", "failed"]);
    expect(bodies).toHaveLength(2);
    expect(snapshot(session, injections.peek())).toEqual(before);
    expect(serializedBoundaryCount(session.records, session)).toBe(0);
  });

  it("rolls back the complete auto compact plan when its boundary cannot append", async () => {
    const bodies: unknown[] = [];
    const { deps, session, injections } = makeDeps("auto-append-reject");
    let nestedMemoryClears = 0;
    deps.clearNestedMemory = () => {
      nestedMemoryClears += 1;
    };
    session.toolOutputArchive = {
      observedCallIds: new Set(["existing-call"]),
      notices: new Map([["existing-call", "existing replacement"]]),
    };
    injections.push("existing injection");
    setLastUsage({
      inputTokens: 123,
      outputTokens: 45,
      cacheCreationInputTokens: 6,
      cacheReadInputTokens: 7,
    });
    const before = compactSnapshot(session, injections.peek(), deps.state);
    blockSessionPersistence(session);
    providers.register(makeProvider("success", bodies));

    const events = await collect(maybeCompact(deps));

    expect(events.filter((event) => event.kind === "compact_done")).toHaveLength(1);
    expect(events.find((event) => event.kind === "compact_done")?.mode).toBe("failed");
    expect(events.some((event) => event.kind === "retry_status")).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(nestedMemoryClears).toBe(0);
    expect(compactSnapshot(session, injections.peek(), deps.state)).toEqual(before);
    expect(serializedBoundaryCount(session.records, session)).toBe(0);
  });

  it("rolls back the complete manual compact plan when its boundary cannot append", async () => {
    const bodies: unknown[] = [];
    let providerSuccesses = 0;
    providers.register({
      ...makeProvider("success", bodies),
      onCompactionSucceeded: () => {
        providerSuccesses += 1;
      },
    });
    const { deps, session, injections } = makeDeps("manual-append-reject");
    deps.state.rapidRefillBreakerOpen = true;
    deps.state.rapidRefillCount = 2;
    deps.state.turnsSinceLast = 4;
    deps.state.lastAutoCompactAttemptTurnId = "prior-turn";
    let nestedMemoryClears = 0;
    deps.clearNestedMemory = () => {
      nestedMemoryClears += 1;
    };
    session.toolOutputArchive = {
      observedCallIds: new Set(["existing-call"]),
      notices: new Map([["existing-call", "existing replacement"]]),
    };
    injections.push("existing injection");
    setLastUsage({
      inputTokens: 123,
      outputTokens: 45,
      cacheCreationInputTokens: 6,
      cacheReadInputTokens: 7,
    });
    const before = compactSnapshot(session, injections.peek(), deps.state);
    const outcomes: string[] = [];
    blockSessionPersistence(session);

    await expect(
      forceCompact(deps, {
        onCompactDone: (info) => outcomes.push(info.mode),
      }),
    ).rejects.toThrow();

    expect(bodies).toHaveLength(1);
    expect(providerSuccesses).toBe(0);
    expect(outcomes).toEqual([]);
    expect(nestedMemoryClears).toBe(0);
    expect(compactSnapshot(session, injections.peek(), deps.state)).toEqual(before);
    expect(serializedBoundaryCount(session.records, session)).toBe(0);
  });
});

function makeDeps(turnId: string): {
  deps: CompactOrchestrationDeps;
  session: Session;
  injections: ReturnType<typeof makeQueue>;
} {
  const session = makeSession();
  const injections = makeQueue();
  const state: CompactState = {
    rapidRefillBreakerOpen: false,
    rapidRefillCount: 0,
    consecutiveCompactFailures: 0,
    turnsSinceLast: Number.POSITIVE_INFINITY,
    lastAutoCompactAttemptTurnId: null,
  };
  let activeAbortController: AbortController | null = null;
  const deps: CompactOrchestrationDeps = {
    agentDeps: {
      session,
      broker: {
        read: () => ({
          provider: "xai",
          model: MODEL,
          effort: "high",
          fastMode: false,
          permissionMode: "default",
          orchestrationMode: "disabled",
          ultracode: false,
        }),
        dispatch: () => {},
      },
      config: { defaultProvider: "xai", defaultModel: MODEL } as never,
      getLastUsage: () => ({
        inputTokens: 150_000,
        outputTokens: 1_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    },
    state,
    turnId,
    activeAbortController: () => activeAbortController,
    setActiveAbortController: (controller) => {
      activeAbortController = controller;
    },
    injections,
    makeCtx: () => ({
      provider: "xai",
      model: MODEL,
      effort: "high",
      fastMode: false,
      permissionMode: "default",
      sessionId: session.id,
      cwd: session.cwd,
      ...(deps.turnId !== null ? { turnId: deps.turnId } : {}),
    }),
  };
  return { deps, session, injections };
}

function makeSession(): Session {
  const session = new Session("compact-state-test", join(base, "repo"));
  session.messages.push(
    { role: "user", content: [{ type: "text", text: "older user" }] },
    {
      id: "assistant-1",
      role: "assistant",
      content: [{ type: "text", text: "older assistant" }],
    },
    { role: "user", content: [{ type: "text", text: "latest user" }] },
    {
      id: "assistant-2",
      role: "assistant",
      content: [{ type: "text", text: "latest assistant" }],
    },
  );
  session.records.push(
    { type: "user_message", ts: TS, uuid: "user-1", content: "older user" },
    { type: "assistant_message", ts: TS, uuid: "assistant-1", content: "older assistant" },
    { type: "user_message", ts: TS, uuid: "user-2", content: "latest user" },
    { type: "assistant_message", ts: TS, uuid: "assistant-2", content: "latest assistant" },
  );
  return session;
}

function makeProvider(mode: ProviderMode, bodies: unknown[]): Provider {
  return {
    ...originalXai,
    id: "xai",
    translateRequest: (_ctx, messages, tools) => {
      const body = { messages, tools };
      bodies.push(body);
      return body;
    },
    startStreamAttempt: () => ({
      events: (async function* () {
        yield { kind: "message_start", id: "compact-message" };
        for (const event of providerEvents(mode)) yield event;
      })(),
      abort: () => {},
    }),
  };
}

function providerEvents(mode: ProviderMode): ProviderEvent[] {
  if (mode === "refusal") {
    return [
      {
        kind: "message_stop",
        stop_reason: "refusal",
        refusal: "summary request refused",
      },
    ];
  }
  if (mode === "quota") {
    return [
      {
        kind: "quota_exhausted",
        provider: "xai",
        model: MODEL,
        resetEpochMs: null,
        message: "summary quota exhausted",
      },
    ];
  }
  if (mode === "cancelled") {
    return [{ kind: "message_stop", stop_reason: "cancelled" }];
  }
  if (mode === "short") {
    return [
      { kind: "text_delta", text: "too short" },
      { kind: "message_stop", stop_reason: "stop" },
    ];
  }
  return [
    {
      kind: "text_delta",
      text: "Summary: enough compacted conversation detail to remain valid and resumable after this successful request.",
    },
    { kind: "message_stop", stop_reason: "stop" },
  ];
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function snapshot(session: Session, injections: readonly string[]): unknown {
  return structuredClone({
    messages: session.messages,
    records: session.records,
    injections: [...injections],
  });
}

function compactSnapshot(
  session: Session,
  injections: readonly string[],
  compactState: CompactState,
): unknown {
  return structuredClone({
    messages: session.messages,
    records: session.records,
    injections: [...injections],
    usage: getLastUsage(),
    compactState,
    toolOutputArchive: session.toolOutputArchive,
  });
}

function blockSessionPersistence(session: Session): void {
  const path = sessionPathForCwd(session.storageCwd, session.id);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(path);
}

function serializedBoundaryCount(records: readonly SessionRecord[], session: Session): number {
  const chain = new SessionChain();
  return records
    .map((record) => serializeRecord(record, chain, session.stamp()))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.type === "system" && line.subtype === "compact_boundary").length;
}

function persistSessionRecords(session: Session): void {
  const path = sessionPathForCwd(session.storageCwd, session.id);
  mkdirSync(dirname(path), { recursive: true });
  const chain = new SessionChain();
  const lines = session.records.map((record) => serializeRecord(record, chain, session.stamp()));
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
