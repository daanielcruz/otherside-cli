import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { runForkLoopInContext } from "../loop-runner.ts";
import type { ForkSpec } from "../types.ts";

let tempDir: string;
let originalEphemeralSessionsDir: string | undefined;

beforeAll(() => {
  registerAllBuiltins();
});

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "otherside-retry-rebuild-test-"));
  originalEphemeralSessionsDir = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = tempDir;
});

afterEach(async () => {
  if (originalEphemeralSessionsDir === undefined) {
    delete process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  } else {
    process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = originalEphemeralSessionsDir;
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("fork stream retry request rebuild", () => {
  it("re-translates the request body on each retry attempt", async () => {
    const providerId = "retry-rebuild-provider";
    let translateCalls = 0;
    let responseAttempts = 0;

    // Attempt 0 fails with a recoverable error; attempt 1 succeeds. A
    // per-session recovery (e.g. dropping a rejected reasoning replay) only
    // reaches the wire if the retried attempt rebuilds the body, so the
    // translate-call count must track the attempt count.
    const mockConfig: ProviderConfig<"openai-completions"> = {
      provider: {
        id: providerId as ProviderId,
        api: "openai-completions",
        sourceId: "builtin" as ApiProviderSourceId,
        label: "Mock Provider",
        shortKey: "mock",
      },
      fingerprint: () => ({ name: "test", version: "1" }) as unknown as WireFingerprint,
      translateRequest: (_ctx: RequestContext, _messages: Message[], _tools: unknown[]) => {
        translateCalls += 1;
        return { attempt: translateCalls };
      },
      translateResponse: (_raw: AsyncIterable<Uint8Array>) => {
        const attempt = responseAttempts++;
        return (async function* () {
          if (attempt === 0) throw new Error("first attempt rejected");
          yield { kind: "message_start" as const };
          yield {
            kind: "text_delta" as const,
            text: "The retried attempt recovered and the assigned task finished successfully, with every requested step completed and verified end to end.",
          };
          yield { kind: "message_stop" as const, stop_reason: "stop" };
        })();
      },
      stream: (_ctx: RequestContext, _body: unknown) =>
        (async function* () {
          yield new Uint8Array();
        })(),
      featureFlags: {} as unknown as ProviderFeatureFlags,
      defaultModelId: "mock-model",
      fallbackEfforts: { levels: [], default: "low" } as unknown as FallbackEfforts,
      deferredOverrides: {
        excludeFromCatalog: [],
        alwaysDeclare: [],
        emitDeferredReminder: false,
      },
      promptAdapter: {} as unknown as ProviderPromptAdapter,
      recoverableError: () => ({ kind: "retry", delayMs: 0, reason: "recover once" }),
      usageDetails: { sourceLabel: "mock" },
      beginLogin: {} as unknown as LoginFlow,
      composeMessages: (_harness: unknown, history: Message[]) => history,
      auth: { strategy: "none" } as unknown as AuthStrategy,
    };
    registerProviderConfig(mockConfig);

    try {
      const spec: ForkSpec = {
        name: "test-retry-rebuild-fork",
        body: "Test retry rebuild",
        allowSet: new Set(),
        prompt: "Trigger a retry",
        ctx: {
          provider: providerId as ProviderId,
          model: "mock-model",
          cwd: tempDir,
          sessionId: "test-session-retry-rebuild",
          permissionMode: "default",
          effort: null,
        },
      };

      const result = await runForkLoopInContext(spec, "fork-retry-rebuild", spec.ctx);
      expect(result.isError).toBe(false);
      expect(responseAttempts).toBe(2);
      // One body per attempt: the retry rebuilt the request.
      expect(translateCalls).toBe(2);
    } finally {
      unregisterProviderConfig(providerId as ProviderId);
    }
  });
});
