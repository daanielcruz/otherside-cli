import { afterAll, describe, expect, it, mock } from "bun:test";
import * as accountIdentityModule from "@/engine/providers/_shared/account-identity.ts";
import * as sessionModule from "@/engine/session/index.ts";

const appendedRecords: unknown[] = [];
const originalSession: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(sessionModule)) {
  originalSession[key] = (sessionModule as Record<string | symbol, unknown>)[key];
}

const originalAccountIdentity: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(accountIdentityModule)) {
  originalAccountIdentity[key] = (accountIdentityModule as Record<string | symbol, unknown>)[key];
}

mock.module("@/engine/session/index.ts", () => ({
  ...originalSession,
  appendRecord: async (_session: unknown, record: unknown) => {
    appendedRecords.push(record);
  },
  nowIso: () => "2026-07-04T00:00:00.000Z",
}));

mock.module("@/engine/providers/_shared/account-identity.ts", () => ({
  ...originalAccountIdentity,
  accountFingerprint: () => null,
}));

afterAll(() => {
  mock.module("@/engine/session/index.ts", () => originalSession);
  mock.module("@/engine/providers/_shared/account-identity.ts", () => originalAccountIdentity);
});

import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { createStreamCommitter, type StreamCommitterDeps } from "../turn/stream-committer.ts";
import { makeTuiTurnObserver, type TuiTurnObserverDeps } from "../turn/tui-observer.ts";

function makeCommitter(overrides: Partial<StreamCommitterDeps> = {}) {
  const deps = {
    startId: "m1",
    session: { messages: [] } as never,
    turnState: { provider: "anthropic", model: "test-model" } as never,
    setStreamingText: () => {},
    setStreamingThinking: () => {},
    setStreamingCommittedLen: () => {},
    setTranscript: () => {},
    takeRequestUsageStamp: () => null,
    appendUsageOnlyAssistantRecord: async () => {},
    ...overrides,
  } satisfies StreamCommitterDeps;
  return createStreamCommitter(deps);
}

function makeObserver(overrides: Partial<TuiTurnObserverDeps> = {}) {
  const turnState = { provider: "anthropic", model: "test-model" } as never;
  const deps = {
    startId: "m1",
    session: { id: "s1", cwd: "/tmp", eventSeq: 1, messages: [] } as never,
    broker: { read: () => turnState } as never,
    turnState,
    recordProviderUsage: () => {},
    mergeContextUsageSnapshot: (previous) => previous,
    setStreamingText: () => {},
    setStreamingThinking: () => {},
    setStreamingCommittedLen: () => {},
    setStreamingId: () => {},
    setTranscript: () => {},
    setProgressInputTokens: () => {},
    setProgressStartedAt: () => {},
    setTasksExpanded: () => {},
    setCodexUsage: () => {},
    setMainTokenTotals: () => {},
    setMainLastContext: () => {},
    setContextWarningSuppressed: () => {},
    setAgentNested: () => {},
    setAgentBackgrounded: () => {},
    agentModelByCallIdRef: { current: new Map() },
    activeToolsRef: { current: 0 },
    forkActionRef: { current: new Map() },
    currentAgentCallIdRef: { current: null },
    forkToCallIdRef: { current: new Map() },
    turnHadVisibleOutputRef: { current: false },
    turnSeedRef: { current: 1 },
    endThinkingStatus: () => {},
    beginThinkingStatus: () => {},
    handleQuotaExhausted: () => {},
    showErrorPanel: () => {},
    agentBlockText: () => "",
    askAnswerEntry: () => null,
    silentToolNames: new Set<string>(),
    dispatch: () => {},
    setLiveOutputTokens: () => {},
    emitPushEvent: () => {},
    ...overrides,
  } satisfies TuiTurnObserverDeps;
  return makeTuiTurnObserver(deps);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("stream committer live text", () => {
  it("paints the first text delta immediately", async () => {
    const published: string[] = [];
    const committer = makeCommitter({
      setStreamingText: (value) => {
        if (typeof value === "string") published.push(value);
      },
    });

    committer.addText("hello ");
    expect(published).toEqual(["hello "]);

    committer.addText("world");
    expect(published).toEqual(["hello "]);

    await sleep(150);
    expect(published[published.length - 1]).toBe("hello world");
  });

  it("throttles a fast delta burst to about one publish per 100ms window", async () => {
    const published: string[] = [];
    const committer = makeCommitter({
      setStreamingText: (value) => {
        if (typeof value === "string") published.push(value);
      },
    });

    const start = Date.now();
    let i = 0;
    while (Date.now() - start < 500) {
      committer.addText(`${i} `);
      i += 1;
      await sleep(10);
    }
    await sleep(150); // let the last trailing timer settle

    // Cold start paints on the first delta, then the throttle caps the rest to
    // one publish per 100ms window: a ~500ms burst should land ~5-6 publishes,
    // not ~10-12 (one leading + one trailing publish per window, the a4e2c315
    // regression this test guards against).
    expect(published.length).toBeGreaterThanOrEqual(4);
    expect(published.length).toBeLessThanOrEqual(7);
  });

  it("keeps full accumulated text when flushAssistant cancels the trailing timer", async () => {
    const published: string[] = [];
    const committer = makeCommitter({
      setStreamingText: (value) => {
        if (typeof value === "string") published.push(value);
      },
    });

    committer.addText("hello ");
    committer.addText("world");
    const entries = await committer.flushAssistant();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "assistant", text: "hello world" });
    expect(published).toEqual(["hello "]);
    await sleep(150);
    expect(published).toEqual(["hello "]);
  });

  it("flushes pending message_stop text before clearing the live stream", () => {
    const published: string[] = [];
    const handle = makeObserver({
      setStreamingText: (value) => {
        if (typeof value === "string") published.push(value);
      },
    });

    handle.observer.text_delta?.({ kind: "text_delta", text: "hello " });
    handle.observer.text_delta?.({ kind: "text_delta", text: "world" });
    handle.observer.message_stop?.({ kind: "message_stop", stop_reason: "end_turn" });

    expect(published).toEqual(["hello ", "hello world", ""]);
  });
});

describe("stream committer thinking block boundaries", () => {
  it("keeps deltas of one thinking block contiguous", () => {
    const committer = makeCommitter();
    committer.addThinking("first half ");
    committer.addThinking("second half.");
    expect(committer.snapshot().accThinking).toBe("first half second half.");
  });

  it("inserts a paragraph break between blocks split by a signature", () => {
    const committer = makeCommitter();
    committer.addThinking("...rather than doing it myself.");
    committer.setSignature("sig-block-1");
    committer.addThinking("Vou identificar os 4 fatos.");
    expect(committer.snapshot().accThinking).toBe(
      "...rather than doing it myself.\n\nVou identificar os 4 fatos.",
    );
  });

  it("inserts a paragraph break when text interleaves between thinking blocks", () => {
    const committer = makeCommitter();
    committer.addThinking("thinking block one.");
    committer.addText("spoken text.");
    committer.addThinking("thinking block two.");
    expect(committer.snapshot().accThinking).toBe("thinking block one.\n\nthinking block two.");
  });

  it("does not stack blank lines when the block already ends with newlines", () => {
    const committer = makeCommitter();
    committer.addThinking("paragraph one.\n\n");
    committer.setSignature("sig");
    committer.addThinking("paragraph two.");
    expect(committer.snapshot().accThinking).toBe("paragraph one.\n\nparagraph two.");
  });
});

describe("stream committer live thinking", () => {
  it("addThinking schedules a flush that publishes the accumulated thinking", async () => {
    const published: string[] = [];
    const committer = makeCommitter({
      setStreamingThinking: (value) => {
        if (typeof value === "string") published.push(value);
      },
    });
    committer.addThinking("pondering ");
    committer.addThinking("deeply.");
    expect(published).toEqual([]);
    await sleep(150);
    expect(published).toEqual(["pondering deeply."]);
  });

  it("clears the live thinking value on flushAssistant", async () => {
    const published: string[] = [];
    const committer = makeCommitter({
      setStreamingThinking: (value) => {
        if (typeof value === "string") published.push(value);
      },
    });
    committer.addThinking("half a thought");
    await committer.flushAssistant();
    expect(published[published.length - 1]).toBe("");
    await sleep(150);
    // No stale re-publish after the flush reset.
    expect(published[published.length - 1]).toBe("");
  });

  it("clears the live thinking value on freeze", () => {
    const published: string[] = [];
    const committer = makeCommitter({
      setStreamingThinking: (value) => {
        if (typeof value === "string") published.push(value);
      },
    });
    committer.addThinking("interrupted thought");
    committer.freeze();
    expect(published[published.length - 1]).toBe("");
  });
});

describe("stream committer thinking headline promotion", () => {
  it("promotes a headline paragraph out of the committed thinking entry", async () => {
    const headlines: string[] = [];
    const committer = makeCommitter({
      onThinkingHeadline: (h) => headlines.push(h),
      reasoningHeadlinesEnabled: () => true,
    });
    committer.addThinking("**Planning the approach**\n\nreal body here");

    const entries = await committer.flushAssistant();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "thinking", text: "real body here" });
    expect(headlines).toEqual(["Planning the approach"]);
  });

  it("commits no thinking entry when a block is only a headline", async () => {
    const headlines: string[] = [];
    const committer = makeCommitter({
      onThinkingHeadline: (h) => headlines.push(h),
      reasoningHeadlinesEnabled: () => true,
    });
    committer.addThinking("**Just a headline**");

    const entries = await committer.flushAssistant();

    expect(entries).toEqual([]);
    expect(headlines).toEqual(["Just a headline"]);
  });

  it("strips every headline across multiple sections and ends on the last one", async () => {
    const headlines: string[] = [];
    const committer = makeCommitter({
      onThinkingHeadline: (h) => headlines.push(h),
      reasoningHeadlinesEnabled: () => true,
    });
    committer.addThinking("**H1**\n\nbody1\n\n**H2**\n\nbody2");

    const entries = await committer.flushAssistant();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "thinking", text: "body1\n\nbody2" });
    expect(headlines[headlines.length - 1]).toBe("H2");
  });

  it("leaves prose thinking byte-identical when no paragraph is a bare bold headline", async () => {
    const headlines: string[] = [];
    const prose = "Let me think about this problem.\n\nFirst I'll check the file, then decide.";
    const committer = makeCommitter({
      onThinkingHeadline: (h) => headlines.push(h),
      reasoningHeadlinesEnabled: () => true,
    });
    committer.addThinking(prose);

    const entries = await committer.flushAssistant();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "thinking", text: prose });
    expect(headlines).toEqual([]);
  });

  it("promotes a headline as soon as its paragraph boundary arrives, before flush", () => {
    const headlines: string[] = [];
    const committer = makeCommitter({
      onThinkingHeadline: (h) => headlines.push(h),
      reasoningHeadlinesEnabled: () => true,
    });
    committer.addThinking("**Scanning files**");
    expect(headlines).toEqual([]);
    committer.addThinking("\n\nmore body");
    expect(headlines).toEqual(["Scanning files"]);
  });

  it("keeps headlines out of the live streaming thinking view", () => {
    const live: string[] = [];
    const committer = makeCommitter({
      setStreamingThinking: (value) => {
        live.push(typeof value === "function" ? value(live.at(-1) ?? "") : value);
      },
      reasoningHeadlinesEnabled: () => true,
    });
    committer.addThinking("**Planning the approach**\n\nreal body");
    committer.flushLive();
    expect(live.at(-1)).toBe("real body");

    committer.addThinking("\n\n**Next se");
    committer.flushLive();
    // Trailing partial headline is held back until its closing ** arrives.
    expect(live.at(-1)).toBe("real body");
  });

  it("passes bold thinking paragraphs through untouched when the provider flag is off", async () => {
    const headlines: string[] = [];
    const bold = "**Weighing the options**\n\nchecking both call sites";
    const committer = makeCommitter({ onThinkingHeadline: (h) => headlines.push(h) });
    committer.addThinking(bold);

    const entries = await committer.flushAssistant();

    // No reasoningHeadlinesEnabled dep (non-headline provider, e.g. grok):
    // bold paragraphs are ordinary thinking prose — nothing is stripped or
    // promoted to the spinner.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "thinking", text: bold });
    expect(headlines).toEqual([]);
  });
});

describe("tui observer headline dispatch", () => {
  it("dispatches view/setTurnVerb with the promoted headline via thinking_delta", () => {
    const dispatched: Array<{ type: string; verb?: string }> = [];
    const handle = makeObserver({
      dispatch: (action) => dispatched.push(action as { type: string; verb?: string }),
      // headline promotion is provider-gated (featureFlags.reasoningHeadlines)
      turnState: { provider: "codex", model: "gpt-5.6-sol" } as never,
    });

    handle.observer.thinking_delta?.({ kind: "thinking_delta", text: "**Reading the code**" });
    handle.observer.thinking_delta?.({ kind: "thinking_delta", text: "\n\nlooking closer" });

    expect(dispatched).toContainEqual({ type: "view/setTurnVerb", verb: "Reading the code" });
  });
});

describe("stream committer record enrichment", () => {
  it("carries the latest assistant request id into persisted records", async () => {
    appendedRecords.length = 0;
    const session = {
      messages: [{ role: "assistant", content: [], requestId: "req-123" }],
    } as never;
    const committer = makeCommitter({ session });
    committer.addText("answer");

    await committer.flushAssistant();

    expect(appendedRecords[0]).toEqual(expect.objectContaining({ requestId: "req-123" }));
  });
});

describe("stream committer stream_reset", () => {
  it("reset voids accumulators and clears the live stream", () => {
    const texts: string[] = [];
    const thinkings: string[] = [];
    const committer = makeCommitter({
      setStreamingText: (value) => {
        if (typeof value === "string") texts.push(value);
      },
      setStreamingThinking: (value) => {
        if (typeof value === "string") thinkings.push(value);
      },
    });
    committer.addText("partial answer");
    committer.addThinking("partial thought");
    committer.reset();
    expect(committer.snapshot()).toEqual({ acc: "", accThinking: "" });
    expect(texts[texts.length - 1]).toBe("");
    expect(thinkings[thinkings.length - 1]).toBe("");
  });

  it("reset removes this attempt's live stable chunks from the transcript", async () => {
    let transcript: readonly TranscriptEntry[] = [];
    const committer = makeCommitter({
      setTranscript: (value) => {
        transcript = typeof value === "function" ? value(transcript) : value;
      },
    });
    committer.addText("stable paragraph.\n\ntail still streaming");
    await sleep(150);
    expect(transcript.some((entry) => entry.id.startsWith("m1_sc"))).toBe(true);
    committer.reset();
    expect(transcript.some((entry) => entry.id.startsWith("m1_sc"))).toBe(false);
  });

  it("flush after reset commits only the fresh re-streamed content", async () => {
    let transcript: readonly TranscriptEntry[] = [];
    const committer = makeCommitter({
      setTranscript: (value) => {
        transcript = typeof value === "function" ? value(transcript) : value;
      },
    });
    committer.addText("discarded partial.\n\n");
    committer.reset();
    committer.addText("fresh full answer");
    const entries = await committer.flushAssistant();
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ kind: "assistant", text: "fresh full answer" });
    expect((entries[0] as { continuation?: boolean }).continuation).toBeUndefined();
  });
});
