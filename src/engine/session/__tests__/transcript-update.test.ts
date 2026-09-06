import { describe, expect, it } from "bun:test";
import {
  applyAgentIdentityToTranscript,
  resolveToolCompletion,
  rewriteClearedToolResults,
} from "../record/transcript-update.ts";
import type { TranscriptEntry } from "../record/types.ts";

function agentEntry(id: string, args: Record<string, unknown>): TranscriptEntry {
  return { id, kind: "tool", title: "Agent", text: JSON.stringify(args) } as TranscriptEntry;
}

describe("applyAgentIdentityToTranscript", () => {
  it("stamps the resolved name into tier-dispatch args", () => {
    const entries = [agentEntry("t_c1", { description: "scan", tier: "daimyo" })];
    const next = applyAgentIdentityToTranscript(entries, "c1", { name: "Generalist" });
    const parsed = JSON.parse(next[0]?.text ?? "{}");
    expect(parsed.subagent_type).toBe("Generalist");
  });

  it("never overwrites an explicit subagent_type", () => {
    const entries = [agentEntry("t_c1", { subagent_type: "fork", description: "x" })];
    const next = applyAgentIdentityToTranscript(entries, "c1", { name: "Generalist" });
    expect(JSON.parse(next[0]?.text ?? "{}").subagent_type).toBe("fork");
  });

  it("updates the backgrounded row too", () => {
    const entries = [agentEntry("b_c1", { status: "backgrounded", description: "x" })];
    const next = applyAgentIdentityToTranscript(entries, "c1", {
      model: "gemini-3-flash",
      name: "Generalist",
    });
    expect(JSON.parse(next[0]?.text ?? "{}").subagent_type).toBe("Generalist");
    expect(next[0]?.agentModel).toBe("gemini-3-flash");
  });

  it("returns the same array when nothing changes", () => {
    const entries = [agentEntry("t_other", { description: "x" })];
    expect(applyAgentIdentityToTranscript(entries, "c1", { name: "n" })).toBe(entries);
  });
});

describe("resolveToolCompletion", () => {
  it("tool completion resolves in place", () => {
    const entries = [agentEntry("b_c1", { status: "backgrounded" })];
    const resolved = agentEntry("r_c1", { status: "completed" });
    const next = resolveToolCompletion(entries, {
      runningId: "t_c1",
      backgroundedId: "b_c1",
      resolved,
    });
    expect(next.map((entry) => entry.id)).toEqual(["r_c1"]);
  });

  it("tool completion appends when no running entry exists", () => {
    const entries = [agentEntry("other", { status: "open" })];
    const resolved = agentEntry("r_c1", { status: "completed" });
    const next = resolveToolCompletion(entries, {
      runningId: "t_c1",
      backgroundedId: "b_c1",
      resolved,
    });
    expect(next.map((entry) => entry.id)).toEqual(["other", "r_c1"]);
  });
});

describe("rewriteClearedToolResults", () => {
  it("rewrites matching tool results", () => {
    const entries: TranscriptEntry[] = [
      { id: "r_c1", kind: "tool", title: "Bash", text: "big output" },
      { id: "r_c2", kind: "tool", title: "Bash", text: "other output" },
    ];
    const next = rewriteClearedToolResults(entries, new Set(["c1", "c2"]), "[cleared]");
    expect(next[0]?.text).toBe("[cleared]");
    expect(next[1]?.text).toBe("[cleared]");
  });
});
