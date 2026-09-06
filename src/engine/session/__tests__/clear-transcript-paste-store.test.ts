import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@/engine/queue/index.ts";
import type { TurnGuard } from "@/engine/queue/runtime/turn/guard.ts";
import { createClearTranscript } from "@/engine/session/clear-transcript.ts";
import { Session } from "@/engine/session/index.ts";
import { getActivePasteStore, setActivePasteStore } from "@/kernel/std/paste/registry.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import type { BrokerHandle } from "@/kernel/std/types/request.ts";

/**
 * The clear takes its store factory as a dependency, so the test supplies one
 * rather than reaching for the concrete store the outer layer owns.
 */
function createPasteStore(): PasteStore {
  const held = new Map<number, { id: number; type: "text" | "image"; content: string }>();
  let nextId = 1;
  return {
    add(item) {
      const id = nextId++;
      held.set(id, { id, type: item.type, content: item.content });
      return { id, placeholder: `[Image #${id}]` };
    },
    get: (id) => held.get(id),
    list: () => [...held.values()],
    clear: () => held.clear(),
  };
}

let base: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "clear-paste-store-"));
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
});

afterEach(() => {
  setActivePasteStore(null);
  if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  rmSync(base, { recursive: true, force: true });
});

function clearer(options?: { skillAbortRef?: { current: AbortController | null } }) {
  const session = new Session("clear-paste-session", base);
  const pasteStoreRef = { current: createPasteStore() };
  const skillAbortRef = options?.skillAbortRef ?? { current: null };
  setActivePasteStore(pasteStoreRef.current);

  const noop = (): void => {};
  const clearTranscript = createClearTranscript({
    session,
    broker: {
      read: () => ({
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        fastMode: false,
        permissionMode: "default",
        orchestrationMode: "disabled",
      }),
    } as unknown as BrokerHandle,
    agent: {
      cancel: noop,
      resetMicrocompactState: noop,
      resetSessionScopedPermissions: noop,
    } as unknown as Agent,
    sessionTitle: { reset: noop } as never,
    createPasteStore,
    setTranscript: noop,
    setStreamingId: noop,
    setStreamingText: noop,
    setStreamingThinking: noop,
    setStreamingCommittedLen: noop,
    setBusy: noop,
    setProgressStartedAt: noop,
    setProgressInputTokens: noop,
    setLiveOutputTokens: noop,
    setMainLastContext: noop,
    dispatch: noop,
    queueActions: { clear: noop },
    transcriptBatch: { flushNow: noop },
    resetRenderSurface: noop,
    runSessionFinalizers: noop,
    abortAllForkControllers: noop,
    runningRef: { current: false },
    turnGuard: { abort: noop } as unknown as TurnGuard,
    skillAbortRef,
    currentAgentCallIdRef: { current: null },
    generatorActiveRef: { current: false },
    compactTerminalRef: { current: false },
    pasteStoreRef,
  });
  return { clearTranscript, pasteStoreRef, skillAbortRef };
}

describe("the paste store a cleared session holds", () => {
  test("is the one the turn will expand against, not the one left behind", () => {
    const { clearTranscript, pasteStoreRef } = clearer();

    clearTranscript();

    // Whoever holds an image reaches the store through the registry while the
    // turn expands against the ref; two different stores means every reference
    // minted after the clear resolves to nothing.
    expect(getActivePasteStore()).toBe(pasteStoreRef.current);
  });

  test("resolves a reference minted after the clear back to its image", () => {
    const { clearTranscript, pasteStoreRef } = clearer();

    clearTranscript();

    const held = getActivePasteStore();
    if (held === null) throw new Error("no active paste store after clear");
    const { id } = held.add({ type: "image", content: "AAAA", mediaType: "image/png" });
    expect(pasteStoreRef.current.get(id)?.content).toBe("AAAA");
  });

  test("aborts any live skill fork when clear is called", () => {
    const liveController = new AbortController();
    const skillAbortRef = { current: liveController };
    const { clearTranscript } = clearer({ skillAbortRef });

    expect(liveController.signal.aborted).toBe(false);
    clearTranscript();
    expect(liveController.signal.aborted).toBe(true);
    expect(skillAbortRef.current).toBeNull();
  });
});
