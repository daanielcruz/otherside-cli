import { describe, expect, test } from "bun:test";
import { drainOrphanInterrupts } from "@/engine/queue/runtime/orphan-synth.ts";

describe("orphan-synth", () => {
  test("T21 collapses unseen tool calls into sticky interrupt_bash items", () => {
    const toolCalls = [
      { id: "bash1", name: "Bash", input: {} },
      { id: "agent1", name: "Agent", input: {} },
      { id: "tx", name: "Glob", input: {} },
    ];
    const seen = new Set<string>(["agent1"]);
    const out = drainOrphanInterrupts({ toolCalls, seen });
    expect(out.length).toBe(2);
    const ids = out.map((i) =>
      i.payload.kind === "tool_result_interrupt" ? i.payload.toolUseId : "",
    );
    expect(ids).toContain("bash1");
    expect(ids).toContain("tx");
    for (const item of out) {
      expect(item.class).toBe("interrupt_bash");
      expect(item.sticky).toBe(true);
      expect(item.replayKey).toMatch(/^orphan:/);
    }
  });

  test("T22 sticky orphan replayKey shape stable across turns", () => {
    const toolCalls = [{ id: "bash1", name: "Bash", input: {} }];
    const seen = new Set<string>();
    const a = drainOrphanInterrupts({ toolCalls, seen });
    const b = drainOrphanInterrupts({ toolCalls, seen });
    const first = a[0];
    const second = b[0];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    expect(first.replayKey).toBe(second.replayKey);
  });
});
