import { describe, expect, it } from "bun:test";
import { applyAgentIdentityToTranscript } from "../record/transcript-update.ts";
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
