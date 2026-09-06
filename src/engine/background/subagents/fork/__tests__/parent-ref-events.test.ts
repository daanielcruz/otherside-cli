import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStrategy } from "@/engine/contract/auth.ts";
import type { FallbackEfforts, ProviderFeatureFlags } from "@/engine/contract/feature-flags.ts";
import type { LoginFlow } from "@/engine/contract/login.ts";
import type { ProviderPromptAdapter } from "@/engine/contract/prompt-adapter.ts";
import { registerProviderConfig, unregisterProviderConfig } from "@/engine/contract/registry.ts";
import type { ApiProviderSourceId, ProviderConfig } from "@/engine/contract/types.ts";
import type { WireFingerprint } from "@/engine/contract/wire-fingerprint.ts";
import type { ForkEvent, ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { runForkLoopInContext } from "../loop-runner.ts";
import type { ForkSpec } from "../types.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "otherside-parent-ref-test-"));
  process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = tempDir;
});

afterEach(async () => {
  delete process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

function createMockProviderConfig(id: string, streamEvents: ProviderEvent[][]): void {
  let callCount = 0;
  const mockConfig: ProviderConfig<"openai-completions"> = {
    provider: {
      id: id as ProviderId,
      api: "openai-completions",
      sourceId: "builtin" as ApiProviderSourceId,
      label: "Mock Provider",
      shortKey: "mock",
    },
    fingerprint: () => {
      return { name: "test", version: "1" } as unknown as WireFingerprint;
    },
    translateRequest: () => ({}),
    translateResponse: (_raw: AsyncIterable<Uint8Array>) => {
      const attempt = callCount++;
      return (async function* () {
        const events = streamEvents[attempt] ?? streamEvents[0] ?? [];
        for (const ev of events) {
          yield ev;
        }
      })();
    },
    stream: (_ctx: RequestContext, _body: unknown) => {
      return (async function* () {
        yield new Uint8Array();
      })();
    },
    featureFlags: {} as unknown as ProviderFeatureFlags,
    defaultModelId: "mock-model",
    fallbackEfforts: { levels: [], default: "low" } as unknown as FallbackEfforts,
    deferredOverrides: {
      excludeFromCatalog: [],
      alwaysDeclare: [],
      emitDeferredReminder: false,
    },
    promptAdapter: {} as unknown as ProviderPromptAdapter,
    recoverableError: () => ({ kind: "fail", reason: "test" }),
    usageDetails: { sourceLabel: "mock" },
    beginLogin: {} as unknown as LoginFlow,
    composeMessages: (_harness: unknown, history: Message[]) => history,
    auth: { strategy: "none" } as unknown as AuthStrategy,
  };
  registerProviderConfig(mockConfig);
}

describe("fork parentToolCallId event threading", () => {
  it("emits fork_usage snapshot and fork_complete with parentToolCallId from the fork spec", async () => {
    const providerId = "parent-ref-events-provider";
    createMockProviderConfig(providerId, [
      [
        { kind: "message_start" },
        {
          kind: "text_delta",
          text: "The nested agent finished its research and returns a complete self-contained summary for the caller.",
        },
        {
          kind: "usage",
          inputTokens: 12,
          outputTokens: 8,
          thoughtTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        { kind: "message_stop", stop_reason: "stop" },
      ],
    ]);

    const emitted: ForkEvent[] = [];
    try {
      const parentToolCallId = "nested-parent-tool-call";
      const spec: ForkSpec = {
        name: "test-parent-ref-fork",
        body: "Thread parentToolCallId",
        allowSet: new Set(),
        prompt: "Emit usage then complete",
        parentToolCallId,
        sink: (event) => {
          emitted.push(event);
        },
        ctx: {
          provider: providerId as ProviderId,
          model: "mock-model",
          cwd: tempDir,
          sessionId: "test-session-parent-ref",
          permissionMode: "default",
          effort: null,
        },
      };

      const result = await runForkLoopInContext(spec, "fork-parent-ref", spec.ctx);
      expect(result.isError).toBe(false);

      const usageSnapshots = emitted.filter(
        (e): e is Extract<ForkEvent, { kind: "fork_usage" }> =>
          e.kind === "fork_usage" && e.isSnapshot === true,
      );
      expect(usageSnapshots.length).toBeGreaterThan(0);
      for (const event of usageSnapshots) {
        expect(event.parentToolCallId).toBe(parentToolCallId);
      }

      const usageTotals = emitted.filter(
        (e): e is Extract<ForkEvent, { kind: "fork_usage" }> =>
          e.kind === "fork_usage" && e.isSnapshot !== true,
      );
      expect(usageTotals.length).toBeGreaterThan(0);
      for (const event of usageTotals) {
        expect(event.parentToolCallId).toBe(parentToolCallId);
      }

      const completes = emitted.filter(
        (e): e is Extract<ForkEvent, { kind: "fork_complete" }> => e.kind === "fork_complete",
      );
      expect(completes.length).toBe(1);
      expect(completes[0]?.parentToolCallId).toBe(parentToolCallId);
      expect(completes[0]?.isError).toBe(false);
    } finally {
      unregisterProviderConfig(providerId as ProviderId);
    }
  });
});
