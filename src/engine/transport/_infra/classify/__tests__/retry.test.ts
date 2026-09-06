import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type PromptCacheDiagnosticRecord,
  resetPromptCacheDiagnosticsForTests,
  setPromptCacheDiagnosticSinkForTests,
} from "@/devtools/prompt-cache.ts";
import { registerProviderConfig, unregisterProviderConfig } from "@/engine/contract/registry.ts";
import type { ProviderConfig, RetryDecision } from "@/engine/contract/types.ts";
import { isRetryableNetworkError } from "@/engine/providers/_shared/retry.ts";
import {
  clearProviderCooldowns,
  DEFAULT_PROVIDER_COOLDOWN_MS,
  getProviderCooldown,
} from "@/engine/session/usage/provider-health.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import { StreamSilenceError } from "@/kernel/std/stream/idle-timeout.ts";
import { ProviderHttpError } from "@/kernel/std/types/error-meta.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BUDGET_MS,
  isContentEvent,
  retryBudgetExhausted,
  STREAM_SILENCE_MIN_ATTEMPTS,
  type StreamRunner,
  streamWithRetry,
} from "../retry.ts";

const originalPromptCacheDiagnostics = process.env.OTHERSIDE_PROMPT_CACHE_DIAG;

beforeEach(() => {
  delete process.env.OTHERSIDE_PROMPT_CACHE_DIAG;
  resetPromptCacheDiagnosticsForTests();
});

afterEach(() => {
  clearProviderCooldowns();
  resetPromptCacheDiagnosticsForTests();
  if (originalPromptCacheDiagnostics === undefined) {
    delete process.env.OTHERSIDE_PROMPT_CACHE_DIAG;
  } else {
    process.env.OTHERSIDE_PROMPT_CACHE_DIAG = originalPromptCacheDiagnostics;
  }
});

const ctx = {
  provider: "test",
  model: "test-model",
} as unknown as RequestContext;
const BUN_SOCKET_CLOSE_MESSAGE =
  "The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()";
const CODEX_WS_CLOSE_MESSAGE = "codex ws closed before completion (code 1006: Connection ended)";

interface RetryRunnerFixture {
  events(): AsyncIterable<ProviderEvent>;
  recoverableError: StreamRunner["recoverableError"];
  getResumeBody?: StreamRunner["getResumeBody"];
  onStart?: (ctx: RequestContext) => void;
  onAbort?: (reason: unknown) => void;
}

function createRetryRunner(fixture: RetryRunnerFixture): StreamRunner {
  return {
    startStreamAttempt: (requestCtx) => {
      fixture.onStart?.(requestCtx);
      return {
        events: fixture.events(),
        abort: fixture.onAbort ?? (() => {}),
      };
    },
    recoverableError: fixture.recoverableError,
    ...(fixture.getResumeBody ? { getResumeBody: fixture.getResumeBody } : {}),
  };
}

async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

function errorWithCode(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function classifyWithoutDelay(
  err: unknown,
  _ctx?: RequestContext,
  attempt?: number,
): RetryDecision {
  const decision = classifyProviderError(err, attempt === undefined ? {} : { attempt });
  return decision.kind === "retry" ? { ...decision, delayMs: 0 } : decision;
}

function registerKeepaliveClassifierProvider(providerId: ProviderId): void {
  const providerConfig: ProviderConfig<"openai-completions"> = {
    provider: {
      id: providerId,
      api: "openai-completions",
      sourceId: "builtin",
      label: "Keepalive classifier test",
      shortKey: "keepalive-test",
    },
    streamEmitsKeepalive: true,
  };
  registerProviderConfig(providerConfig);
}

describe("streamWithRetry resume policy", () => {
  it("re-streams after partial content via stream_reset when the provider cannot resume", async () => {
    let calls = 0;
    const provider = createRetryRunner({
      events: async function* (): AsyncIterable<ProviderEvent> {
        calls += 1;
        if (calls === 1) {
          yield { kind: "text_delta", text: "hel" } as ProviderEvent;
          throw new Error("mid-stream 529");
        }
        yield { kind: "text_delta", text: "hello world" } as ProviderEvent;
      },
      recoverableError: () => ({ kind: "retry" as const }),
    });
    const events = await collect(streamWithRetry(ctx, provider, () => ({}), { baseDelayMs: 0 }));
    expect(calls).toBe(2);
    const resetIdx = events.findIndex((e) => e.kind === "stream_reset");
    const retryIdx = events.findIndex((e) => e.kind === "retry_status");
    // stream_reset lands before retry_status so consumers discard partial
    // state before the retry banner shows.
    expect(resetIdx).toBeGreaterThan(-1);
    expect(retryIdx).toBeGreaterThan(resetIdx);
    expect(events[resetIdx]).toMatchObject({
      kind: "stream_reset",
      attempt: 1,
    });
    expect(events.filter((e) => e.kind === "text_delta").length).toBe(2);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  it("retries normally when the error happens before any content is emitted", async () => {
    let calls = 0;
    const provider = createRetryRunner({
      events: async function* (): AsyncIterable<ProviderEvent> {
        calls += 1;
        if (calls === 1) throw new Error("pre-content 529");
        yield { kind: "text_delta", text: "ok" } as ProviderEvent;
      },
      recoverableError: () => ({ kind: "retry" as const }),
    });
    const events = await collect(streamWithRetry(ctx, provider, () => ({}), { baseDelayMs: 0 }));
    expect(calls).toBe(2);
    expect(events.some((e) => e.kind === "retry_status")).toBe(true);
    expect(events.filter((e) => e.kind === "text_delta").length).toBe(1);
  });

  it("resumes via a provider-supplied resume body instead of failing", async () => {
    let calls = 0;
    const provider = createRetryRunner({
      events: async function* (): AsyncIterable<ProviderEvent> {
        calls += 1;
        if (calls === 1) {
          yield { kind: "text_delta", text: "part" } as ProviderEvent;
          throw new Error("mid-stream");
        }
        yield { kind: "text_delta", text: "rest" } as ProviderEvent;
      },
      recoverableError: () => ({ kind: "retry" as const }),
      getResumeBody: () => ({ resumed: true }),
    });
    const events = await collect(streamWithRetry(ctx, provider, () => ({}), { baseDelayMs: 0 }));
    expect(calls).toBe(2);
    expect(events.some((e) => e.kind === "retry_status")).toBe(true);
    // A provider-supplied resume continues the same message — no reset.
    expect(events.some((e) => e.kind === "stream_reset")).toBe(false);
  });

  it("retries the Bun socket-close fetch error before content", async () => {
    let calls = 0;
    const provider = createRetryRunner({
      events: async function* (): AsyncIterable<ProviderEvent> {
        calls += 1;
        if (calls === 1) throw new Error(BUN_SOCKET_CLOSE_MESSAGE);
        yield { kind: "text_delta", text: "ok" } as ProviderEvent;
      },
      recoverableError: classifyWithoutDelay,
    });
    const events = await collect(streamWithRetry(ctx, provider, () => ({})));
    const retry = events.find((e) => e.kind === "retry_status");
    expect(calls).toBe(2);
    expect(retry).toMatchObject({
      kind: "retry_status",
      attempt: 1,
      maxAttempts: 10,
    });
    expect(events.filter((e) => e.kind === "text_delta").length).toBe(1);
  });

  it("exhausts retries on repeated mid-content failures — one stream_reset per attempt, then throws", async () => {
    let calls = 0;
    const provider = createRetryRunner({
      events: async function* (): AsyncIterable<ProviderEvent> {
        calls += 1;
        yield { kind: "text_delta", text: "part" } as ProviderEvent;
        throw new Error(BUN_SOCKET_CLOSE_MESSAGE);
      },
      recoverableError: classifyWithoutDelay,
    });
    const events: ProviderEvent[] = [];
    let thrown: unknown = null;
    try {
      for await (const ev of streamWithRetry(ctx, provider, () => ({}), {
        maxAttempts: 3,
      })) {
        events.push(ev);
      }
    } catch (err) {
      thrown = err;
    }
    expect(calls).toBe(3);
    // Terminal exhaustion throws (caught by the dispatch-loop error modal);
    // it must NOT yield a soft error event on top of the throw.
    expect(thrown).toBeInstanceOf(Error);
    expect(events.filter((e) => e.kind === "stream_reset").length).toBe(3);
    expect(events.filter((e) => e.kind === "retry_status").length).toBe(2);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  it("logs failed and resumed attempts without promoting either to the cache baseline", async () => {
    process.env.OTHERSIDE_PROMPT_CACHE_DIAG = "1";
    const diagnostics: PromptCacheDiagnosticRecord[] = [];
    setPromptCacheDiagnosticSinkForTests((_sessionId, record) => diagnostics.push(record));
    const diagnosticContext = {
      provider: "anthropic",
      model: "fixture-model",
      effort: "high",
      permissionMode: "default",
      sessionId: "fixture-retry-session",
      cwd: "/workspace/project",
    } as RequestContext;
    let calls = 0;
    const provider = createRetryRunner({
      events: async function* (): AsyncIterable<ProviderEvent> {
        calls += 1;
        yield {
          kind: "message_start",
          id: `msg-${calls}`,
          requestId: `req-${calls}`,
        };
        yield {
          kind: "usage",
          inputTokens: 10,
          outputTokens: 0,
          cacheCreationInputTokens: 26_000,
          cacheReadInputTokens: 0,
        };
        if (calls === 1) {
          yield { kind: "text_delta", text: "partial" };
          throw new Error("fixture mid-stream failure");
        }
        yield { kind: "message_stop", stop_reason: "stop" };
      },
      recoverableError: () => ({ kind: "retry" as const, delayMs: 0 }),
      getResumeBody: () => ({ resumed: true }),
    });

    await collect(
      streamWithRetry(
        diagnosticContext,
        provider,
        {
          model: "fixture-model",
          messages: [{ role: "user", content: "fixture request" }],
        },
        { baseDelayMs: 0 },
      ),
    );

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      attempt: 1,
      outcome: "transport_error",
      classification: "excluded",
      reasonCodes: ["transport_error"],
      resumed: false,
    });
    expect(diagnostics[1]).toMatchObject({
      attempt: 2,
      outcome: "completed",
      classification: "excluded",
      reasonCodes: ["resumed_stream"],
      resumed: true,
    });
  });
});

describe("rate-limit (429/529) classification and exhaustion", () => {
  const rateLimitBody =
    '{"error":{"details":null,"type":"rate_limit_error","message":"Rate limited"}}';

  function http429(overrides: Partial<ConstructorParameters<typeof ProviderHttpError>[0]> = {}) {
    return new ProviderHttpError({
      provider: "/v1/messages",
      status: 429,
      body: rateLimitBody,
      ...overrides,
    });
  }

  it("plain 429 without retry-after retries with backoff", () => {
    const decision = classifyProviderError(http429());
    expect(decision.kind).toBe("retry");
  });

  it("429 with x-should-retry:false still stamps quotaExhausted instead of dying raw", () => {
    const decision = classifyProviderError(http429({ shouldRetryHeader: "false" }));
    expect(decision.kind).toBe("fail");
    expect((decision as { quotaExhausted?: boolean }).quotaExhausted).toBe(true);
  });

  it("exhausting the retry budget on 429 yields quota_exhausted, not a raw throw", async () => {
    let calls = 0;
    const resetEpochMs = Date.now() + 26 * 60 * 60 * 1000;
    const provider = createRetryRunner({
      // biome-ignore lint/correctness/useYield: throws before any yield
      events: async function* (): AsyncIterable<ProviderEvent> {
        calls += 1;
        throw http429({ quotaResetEpochMs: resetEpochMs });
      },
      recoverableError: classifyWithoutDelay,
    });
    const events = await collect(
      streamWithRetry(ctx, provider, () => ({}), {
        maxAttempts: 2,
        baseDelayMs: 0,
      }),
    );
    expect(calls).toBe(2);
    const last = events.at(-1);
    expect(last?.kind).toBe("quota_exhausted");
    expect((last as { message?: string }).message).toContain("Rate limited");
    expect((last as { reason?: string }).reason).toBe("rate_limited");
    expect((last as { resetEpochMs?: number }).resetEpochMs).toBe(resetEpochMs);
    expect(events.some((e) => e.kind === "error")).toBe(false);

    const cooldown = getProviderCooldown(ctx.provider, ctx.model);
    expect(cooldown).not.toBeNull();
    expect(cooldown!.reason).toBe("rate_limited");
    expect(cooldown!.untilEpochMs - cooldown!.observedAtEpochMs).toBe(DEFAULT_PROVIDER_COOLDOWN_MS);
  });

  it("hard quota 429: ProviderHttpError with quotaExhausted:true and quotaResetEpochMs does not mark cooldown", async () => {
    const resetEpochMs = Date.now() + 26 * 60 * 60 * 1000;
    const provider = createRetryRunner({
      // biome-ignore lint/correctness/useYield: throws before any yield
      events: async function* (): AsyncIterable<ProviderEvent> {
        throw new ProviderHttpError({
          provider: "/v1/messages",
          status: 429,
          body: rateLimitBody,
          quotaExhausted: true,
          quotaResetEpochMs: resetEpochMs,
        });
      },
      recoverableError: classifyWithoutDelay,
    });
    const events = await collect(
      streamWithRetry(ctx, provider, () => ({}), {
        maxAttempts: 2,
        baseDelayMs: 0,
      }),
    );
    const last = events.at(-1);
    expect(last?.kind).toBe("quota_exhausted");
    expect((last as { reason?: string }).reason).toBe("quota");
    expect((last as { resetEpochMs?: number }).resetEpochMs).toBe(resetEpochMs);
    expect(getProviderCooldown(ctx.provider, ctx.model)).toBeNull();
  });

  it("exhausting the retry budget on a non-429 error still throws raw", async () => {
    const provider = createRetryRunner({
      // biome-ignore lint/correctness/useYield: throws before any yield
      events: async function* (): AsyncIterable<ProviderEvent> {
        throw new Error("mid-stream 500");
      },
      recoverableError: () => ({ kind: "retry" as const, delayMs: 0 }),
    });
    await expect(
      collect(
        streamWithRetry(ctx, provider, () => ({}), {
          maxAttempts: 2,
          baseDelayMs: 0,
        }),
      ),
    ).rejects.toThrow("mid-stream 500");
  });
});

describe("network retry classification", () => {
  it("classifies a silent stream as a transient network failure", () => {
    // Both classifiers funnel through isRetryableNetworkError, so this single
    // predicate keeps the retry loop and the error-panel retry action agreeing.
    expect(isRetryableNetworkError(new StreamSilenceError(300_000))).toBe(true);
    expect(classifyProviderError(new StreamSilenceError(300_000)).kind).toBe("retry");
  });

  it("classifies Bun and Undici socket close shapes as transient", () => {
    expect(isRetryableNetworkError(new Error(BUN_SOCKET_CLOSE_MESSAGE))).toBe(true);
    expect(classifyProviderError(new Error(BUN_SOCKET_CLOSE_MESSAGE)).kind).toBe("retry");
    expect(isRetryableNetworkError(new Error(CODEX_WS_CLOSE_MESSAGE))).toBe(true);
    expect(classifyProviderError(new Error(CODEX_WS_CLOSE_MESSAGE)).kind).toBe("retry");
    expect(isRetryableNetworkError(errorWithCode("socket closed", "UND_ERR_SOCKET"))).toBe(true);
    expect(
      isRetryableNetworkError(
        new Error("fetch failed", {
          cause: errorWithCode("socket closed", "UND_ERR_SOCKET"),
        }),
      ),
    ).toBe(true);
    expect(
      isRetryableNetworkError(
        new Error(BUN_SOCKET_CLOSE_MESSAGE, {
          cause: errorWithCode("reset", "ECONNRESET"),
        }),
      ),
    ).toBe(true);
  });

  it("classifies AbortSignal.timeout TimeoutError as transient (retryable)", () => {
    const byName = Object.assign(new Error("The operation timed out."), {
      name: "TimeoutError",
    });
    expect(isRetryableNetworkError(byName)).toBe(true);
    expect(classifyProviderError(byName).kind).toBe("retry");
    // message-only fallback (name lost across a boundary) still retries
    const byMessage = new Error("The operation timed out.");
    expect(isRetryableNetworkError(byMessage)).toBe(true);
    // nested in a cause chain
    expect(
      isRetryableNetworkError(
        new Error("fetch failed", {
          cause: Object.assign(new Error("The operation timed out."), {
            name: "TimeoutError",
          }),
        }),
      ),
    ).toBe(true);
  });

  it("classifies Bun runtime connect failures as transient (retryable)", () => {
    // Bun fetch(): code ConnectionRefused, message covers refused AND dns failures
    const bunFetch = errorWithCode(
      "Unable to connect. Is the computer able to access the url?",
      "ConnectionRefused",
    );
    expect(isRetryableNetworkError(bunFetch)).toBe(true);
    expect(classifyProviderError(bunFetch).kind).toBe("retry");
    // Bun socket open: FailedToOpenSocket with the "typo" message
    const bunSocket = errorWithCode("Was there a typo in the url or port?", "FailedToOpenSocket");
    expect(isRetryableNetworkError(bunSocket)).toBe(true);
    expect(classifyProviderError(bunSocket).kind).toBe("retry");
    // message-only fallbacks (code lost across a boundary, e.g. WebSocket onerror)
    expect(isRetryableNetworkError(new Error("Was there a typo in the url or port?"))).toBe(true);
    expect(
      isRetryableNetworkError(
        new Error("WebSocket connection to 'wss://x' failed: Failed to connect"),
      ),
    ).toBe(true);
  });

  it("does not retry terminal abort or certificate failures", () => {
    expect(
      isRetryableNetworkError(Object.assign(new Error("aborted"), { name: "AbortError" })),
    ).toBe(false);
    expect(isRetryableNetworkError(errorWithCode("certificate expired", "CERT_HAS_EXPIRED"))).toBe(
      false,
    );
    expect(
      isRetryableNetworkError(
        new Error("fetch failed", {
          cause: errorWithCode("certificate expired", "CERT_HAS_EXPIRED"),
        }),
      ),
    ).toBe(false);
  });
});

describe("StreamSilenceError classification", () => {
  it("retries byte-level idle timeouts", () => {
    const decision = classifyProviderError(new StreamSilenceError(90_000));
    expect(decision.kind).toBe("retry");
    expect(decision.reason).toContain("byte stream idle 90000ms — reconnecting");
  });

  it("retries content-level idle timeouts without transport keepalive proof", () => {
    const decision = classifyProviderError(new StreamSilenceError(180_000, "content"), {
      provider: "openai",
    });
    expect(decision.kind).toBe("retry");
    expect(decision.reason).toContain("content stream idle 180000ms — reconnecting");
  });

  it("fails content-level idle timeouts when transport keepalives prove the socket is alive", () => {
    const providerId = "keepalive-classifier-test" as ProviderId;
    registerKeepaliveClassifierProvider(providerId);

    try {
      const decision = classifyProviderError(new StreamSilenceError(600_000, "content"), {
        provider: providerId,
      });
      expect(decision.kind).toBe("fail");
      expect(decision.reason).toBe(
        "content stream idle 600000ms — aborting (live connection, no model output)",
      );
    } finally {
      unregisterProviderConfig(providerId);
    }
  });

  it("preserves the terminal idle decision in the surfaced error metadata", async () => {
    const providerId = "keepalive-stream-error-test" as ProviderId;
    registerKeepaliveClassifierProvider(providerId);
    let calls = 0;
    const localCtx = {
      provider: providerId,
      model: "keepalive-test-model",
    } as unknown as RequestContext;
    const provider = createRetryRunner({
      events: (): AsyncIterable<ProviderEvent> => ({
        [Symbol.asyncIterator]() {
          return {
            next: async (): Promise<IteratorResult<ProviderEvent>> => {
              calls += 1;
              throw new StreamSilenceError(600_000, "content");
            },
          };
        },
      }),
      recoverableError: (error: unknown, requestCtx: RequestContext, attempt?: number) => {
        const decision = classifyProviderError(error, {
          attempt: attempt ?? 1,
          provider: requestCtx.provider,
          model: requestCtx.model,
        });
        return decision.kind === "retry" ? { ...decision, delayMs: 0 } : decision;
      },
    });

    try {
      const events = await collect(streamWithRetry(localCtx, provider, {}));
      expect(calls).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "error",
        error: "content stream idle 600000ms — aborting (live connection, no model output)",
        meta: {
          errorClass: "other",
          retryable: false,
          rawDetail: "content stream idle 600000ms — aborting (live connection, no model output)",
          summary: "content stream idle 600000ms — aborting (live connection, no model output)",
          providerContext: {
            provider: providerId,
            model: "keepalive-test-model",
            attempt: 1,
          },
        },
      });
    } finally {
      unregisterProviderConfig(providerId);
    }
  });
});

describe("isContentEvent", () => {
  it("accepts text/thinking deltas and tool_call start/complete as content", () => {
    expect(isContentEvent({ kind: "text_delta" })).toBe(true);
    expect(isContentEvent({ kind: "thinking_delta" })).toBe(true);
    expect(isContentEvent({ kind: "tool_call_start" })).toBe(true);
    expect(isContentEvent({ kind: "tool_call_complete" })).toBe(true);
  });

  it("rejects administrative/control kinds", () => {
    expect(isContentEvent({ kind: "message_start" })).toBe(false);
    expect(isContentEvent({ kind: "retry_status" })).toBe(false);
    expect(isContentEvent({ kind: "stream_reset" })).toBe(false);
  });
});

describe("streamWithRetry fresh-connection marking", () => {
  it("marks ctx.freshConnection after a stream idle timeout and keeps it for later attempts", async () => {
    const localCtx = {
      provider: "test",
      model: "test-model",
    } as unknown as RequestContext;
    let calls = 0;
    const seen: Array<boolean | undefined> = [];
    const provider = createRetryRunner({
      onStart: (requestCtx) => seen.push(requestCtx.freshConnection),
      events: async function* (): AsyncIterable<ProviderEvent> {
        calls += 1;
        if (calls === 1) throw new StreamSilenceError(30_000);
        yield { kind: "text_delta", text: "ok" } as ProviderEvent;
      },
      recoverableError: classifyWithoutDelay,
    });
    await collect(streamWithRetry(localCtx, provider, () => ({}), { baseDelayMs: 0 }));
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe(true);
    expect(localCtx.freshConnection).toBe(true);
  });

  it("does not mark ctx.freshConnection for non-idle retryable errors", async () => {
    const localCtx = {
      provider: "test",
      model: "test-model",
    } as unknown as RequestContext;
    let calls = 0;
    const provider = createRetryRunner({
      events: async function* (): AsyncIterable<ProviderEvent> {
        calls += 1;
        if (calls === 1) throw new Error("mid-stream 529");
        yield { kind: "text_delta", text: "ok" } as ProviderEvent;
      },
      recoverableError: () => ({ kind: "retry" as const, delayMs: 0 }),
    });
    await collect(streamWithRetry(localCtx, provider, () => ({}), { baseDelayMs: 0 }));
    expect(localCtx.freshConnection).toBeUndefined();
  });
});

describe("retry budget", () => {
  it("shares ten attempts and a three-minute elapsed budget", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(10);
    expect(DEFAULT_RETRY_BUDGET_MS).toBe(180_000);
  });

  it("stops at the attempt limit", () => {
    expect(
      retryBudgetExhausted({
        attempts: 10,
        maxAttempts: 10,
        elapsedMs: 10_000,
        nextDelayMs: 0,
        maxElapsedMs: 180_000,
      }),
    ).toBe(true);
  });

  it("stops before a delay would cross the elapsed budget", () => {
    expect(
      retryBudgetExhausted({
        attempts: 4,
        maxAttempts: 10,
        elapsedMs: 175_000,
        nextDelayMs: 6_000,
        maxElapsedMs: 180_000,
      }),
    ).toBe(true);
    expect(
      retryBudgetExhausted({
        attempts: 4,
        maxAttempts: 10,
        elapsedMs: 175_000,
        nextDelayMs: 5_000,
        maxElapsedMs: 180_000,
      }),
    ).toBe(false);
  });

  it("the attempt floor outranks the elapsed budget, never the attempt limit", () => {
    // Below the floor: silence observation time cannot drain the budget.
    expect(
      retryBudgetExhausted({
        attempts: 1,
        maxAttempts: 10,
        elapsedMs: 300_000,
        nextDelayMs: 1_000,
        maxElapsedMs: 180_000,
        minAttempts: STREAM_SILENCE_MIN_ATTEMPTS,
      }),
    ).toBe(false);
    // At the floor: the elapsed budget applies again.
    expect(
      retryBudgetExhausted({
        attempts: 3,
        maxAttempts: 10,
        elapsedMs: 300_000,
        nextDelayMs: 1_000,
        maxElapsedMs: 180_000,
        minAttempts: STREAM_SILENCE_MIN_ATTEMPTS,
      }),
    ).toBe(true);
    // The hard attempt cap always wins over the floor.
    expect(
      retryBudgetExhausted({
        attempts: 2,
        maxAttempts: 2,
        elapsedMs: 0,
        nextDelayMs: 0,
        maxElapsedMs: 180_000,
        minAttempts: STREAM_SILENCE_MIN_ATTEMPTS,
      }),
    ).toBe(true);
  });
});

describe("retry window after mid-stream progress", () => {
  /**
   * Regression: the elapsed budget was anchored at stream start, so a stream
   * that ran successfully past the budget (a long reasoning turn) arrived at
   * its first disconnect with every retry spent — a transient ws close (1006)
   * surfaced the error panel with zero automatic retries.
   */
  it("retries a ws close after progress even when streaming outlived the budget", async () => {
    let starts = 0;
    const provider = createRetryRunner({
      events: async function* (): AsyncIterable<ProviderEvent> {
        starts += 1;
        if (starts === 1) {
          yield { kind: "text_delta", text: "first half" } as ProviderEvent;
          await new Promise((resolve) => setTimeout(resolve, 80));
          throw new Error(CODEX_WS_CLOSE_MESSAGE);
        }
        yield { kind: "text_delta", text: "recovered" } as ProviderEvent;
      },
      recoverableError: classifyWithoutDelay,
    });
    const events = await collect(
      // The budget is smaller than the first attempt's streaming time, so only
      // the progress restamp can admit the retry.
      streamWithRetry(ctx, provider, () => ({}), { maxAttempts: 5, maxElapsedMs: 50 }),
    );
    expect(starts).toBe(2);
    // No server-side resume: the partial tail is discarded before the retry.
    expect(events.some((ev) => ev.kind === "stream_reset")).toBe(true);
    expect(events.some((ev) => ev.kind === "retry_status")).toBe(true);
    expect(
      events.filter((ev) => ev.kind === "text_delta").map((ev) => ("text" in ev ? ev.text : "")),
    ).toEqual(["first half", "recovered"]);
  }, 10_000);

  it("an attempt without progress still drains the elapsed budget", async () => {
    let starts = 0;
    const provider = createRetryRunner({
      events: async function* (): AsyncIterable<ProviderEvent> {
        starts += 1;
        await new Promise((resolve) => setTimeout(resolve, 80));
        throw new Error(CODEX_WS_CLOSE_MESSAGE);
      },
      recoverableError: classifyWithoutDelay,
    });
    await expect(
      collect(streamWithRetry(ctx, provider, () => ({}), { maxAttempts: 5, maxElapsedMs: 50 })),
    ).rejects.toThrow();
    expect(starts).toBe(1);
  }, 10_000);
});

describe("stream-silence retry floor", () => {
  it("retries a silent stream even after the elapsed budget drained", async () => {
    let starts = 0;
    const provider = createRetryRunner({
      events: async function* (): AsyncIterable<ProviderEvent> {
        starts += 1;
        if (starts === 1) throw new StreamSilenceError(300_000);
        yield { kind: "text_delta", text: "recovered" } as ProviderEvent;
      },
      recoverableError: classifyWithoutDelay,
    });
    const events = await collect(
      // maxElapsedMs 0: every elapsed check is already over budget, so only
      // the silence floor can admit the retry.
      streamWithRetry(ctx, provider, () => ({}), { maxAttempts: 5, maxElapsedMs: 0 }),
    );
    expect(starts).toBe(2);
    expect(events.some((ev) => ev.kind === "text_delta")).toBe(true);
    expect(events.some((ev) => ev.kind === "retry_status")).toBe(true);
  }, 10_000);

  it("a non-silence error over budget still fails without the floor", async () => {
    const provider = createRetryRunner({
      // biome-ignore lint/correctness/useYield: throws before any yield
      events: async function* (): AsyncIterable<ProviderEvent> {
        throw new Error("mid-stream 500");
      },
      recoverableError: () => ({ kind: "retry" as const, delayMs: 0 }),
    });
    await expect(
      collect(streamWithRetry(ctx, provider, () => ({}), { maxAttempts: 5, maxElapsedMs: 0 })),
    ).rejects.toThrow("mid-stream 500");
  });
});
