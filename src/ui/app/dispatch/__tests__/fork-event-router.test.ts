import { describe, expect, it } from "bun:test";
import type { ForkEvent } from "@/kernel/std/types/events.ts";
import type { ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";
import { createForkEventRouter } from "@/ui/app/dispatch/fork-event-router.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

function makeHarness() {
  let transcript: readonly TranscriptEntry[] = [];
  const agentModelByCallIdRef = { current: new Map<string, ProviderModelRoute>() };
  const { routeForkEvent } = createForkEventRouter({
    setTranscript: (value) => {
      transcript = typeof value === "function" ? value(transcript) : value;
    },
    forkToCallIdRef: { current: new Map<string, string>() },
    agentModelByCallIdRef,
    setAgentNested: () => {},
    recordProviderUsage: () => {},
    broker: { read: () => ({ provider: "anthropic", model: "test-model" }) },
  });
  return { routeForkEvent, get: () => transcript, agentModelByCallIdRef };
}

function startSkillFork(routeForkEvent: (event: ForkEvent) => void, forkId: string): void {
  routeForkEvent({
    kind: "fork_start",
    forkId,
    name: "dream",
    provider: "anthropic",
    model: "test-model",
  });
}

describe("fork-event-router agent identity", () => {
  it("threads the fork provider+model route into the entry and the call-id ref", () => {
    const { routeForkEvent, get, agentModelByCallIdRef } = makeHarness();
    routeForkEvent({
      kind: "fork_start",
      forkId: "fk-agent",
      name: "general-purpose",
      provider: "kimi",
      model: "k3",
      parentToolCallId: "call-1",
    });

    expect(agentModelByCallIdRef.current.get("call-1")).toEqual({
      provider: "kimi",
      model: "k3",
    });
    // The running entry only exists once the Agent tool row is on screen; the
    // ref is what survives until backgrounding/completion re-renders it.
    routeForkEvent({
      kind: "fork_start",
      forkId: "fk-agent-2",
      name: "general-purpose",
      provider: "codex",
      model: "gpt-5.6-luna",
      parentToolCallId: "call-2",
    });
    expect(agentModelByCallIdRef.current.get("call-2")?.provider).toBe("codex");
    expect(get().length).toBe(0);
  });
});

describe("fork-event-router skill completion", () => {
  it("renders a prose conclusion live as a markdown assistant entry", () => {
    const { routeForkEvent, get } = makeHarness();
    startSkillFork(routeForkEvent, "fk1");
    const output = "Done. The memory set was already in strong shape.\n\n**Updated:** 3 memories";
    routeForkEvent({ kind: "fork_complete", forkId: "fk1", output, isError: false });

    const conclusion = get().find((e) => e.id === "c_fk1");
    expect(conclusion).toBeDefined();
    expect(conclusion?.kind).toBe("assistant");
    expect(conclusion?.text).toBe(output);
    expect(get().some((e) => e.id === "s_fk1")).toBe(false);
  });

  it("keeps the structured one-liner for summary-shaped output and skips the prose entry", () => {
    const { routeForkEvent, get } = makeHarness();
    startSkillFork(routeForkEvent, "fk2");
    const output = "Audit complete. 3 critical · 1 high · 2 medium · 0 low\nReport: /tmp/report.md";
    routeForkEvent({ kind: "fork_complete", forkId: "fk2", output, isError: false });

    const summary = get().find((e) => e.id === "s_fk2");
    expect(summary?.kind).toBe("system");
    expect(get().some((e) => e.id === "c_fk2")).toBe(false);
  });

  it("emits no conclusion entry when the fork produced no output", () => {
    const { routeForkEvent, get } = makeHarness();
    startSkillFork(routeForkEvent, "fk3");
    routeForkEvent({ kind: "fork_complete", forkId: "fk3", output: "", isError: false });

    expect(get().some((e) => e.id === "c_fk3")).toBe(false);
    expect(get().some((e) => e.id === "s_fk3")).toBe(false);
  });

  it("does not render a prose conclusion for an errored fork", () => {
    const { routeForkEvent, get } = makeHarness();
    startSkillFork(routeForkEvent, "fk4");
    routeForkEvent({
      kind: "fork_complete",
      forkId: "fk4",
      output: "boom: something failed",
      isError: true,
    });

    expect(get().some((e) => e.id === "c_fk4")).toBe(false);
  });

  it("finalizes the skill entry to a completed, inactive row", () => {
    const { routeForkEvent, get } = makeHarness();
    startSkillFork(routeForkEvent, "fk5");
    routeForkEvent({
      kind: "fork_complete",
      forkId: "fk5",
      output: "prose result",
      isError: false,
    });

    expect(get().some((e) => e.id === "t_fk5")).toBe(false);
    const finalized = get().find((e) => e.id === "r_fk5");
    expect(finalized?.kind).toBe("skill");
    expect(finalized?.isActive).toBe(false);
  });
});

describe("fork-event-router stream isolation", () => {
  it("keeps agent output and resets out of the main transcript", () => {
    const { routeForkEvent, get } = makeHarness();
    routeForkEvent({
      kind: "fork_start",
      forkId: "agent-fork",
      parentToolCallId: "agent-call",
      name: "worker",
      provider: "codex",
      model: "gpt-5.5",
    });

    routeForkEvent({ kind: "fork_text_delta", forkId: "agent-fork", text: "private reasoning" });
    routeForkEvent({ kind: "fork_stream_reset", forkId: "agent-fork", discardedChars: 7 });
    routeForkEvent({
      kind: "fork_complete",
      forkId: "agent-fork",
      output: "private result",
      isError: false,
    });

    expect(get()).toEqual([]);
  });

  it("continues streaming skill output into its progress row", () => {
    const { routeForkEvent, get } = makeHarness();
    startSkillFork(routeForkEvent, "skill-fork");

    routeForkEvent({ kind: "fork_text_delta", forkId: "skill-fork", text: "public progress" });

    expect(get()[0]?.progress).toEqual([{ kind: "text", text: "public progress" }]);
  });
});

describe("fork-event-router quota handling", () => {
  it("ignores fork_quota_exhausted — no main usage panel, no transcript mutation", () => {
    const { routeForkEvent, get } = makeHarness();
    const before = get().length;
    routeForkEvent({
      kind: "fork_quota_exhausted",
      forkId: "fkq",
      provider: "glm",
      model: "glm-5.2",
      resetEpochMs: null,
      message: "quota exhausted",
    });
    expect(get().length).toBe(before);
  });
});
