import { describe, expect, it } from "bun:test";
import type { SetStateAction } from "react";
import { createAgentTranscriptHelpers } from "@/ui/app/agent-transcript.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

function makeHelpers(initial: TranscriptEntry[]) {
  const captured = { current: initial as readonly TranscriptEntry[] };
  const setTranscript = (v: SetStateAction<readonly TranscriptEntry[]>): void => {
    captured.current = typeof v === "function" ? v(captured.current) : v;
  };
  const helpers = createAgentTranscriptHelpers({
    setTranscript,
    agentModelByCallIdRef: { current: new Map() },
  });
  return { helpers, captured };
}

describe("createAgentTranscriptHelpers", () => {
  describe("setAgentNested", () => {
    it("applies the mutator to the matching entry's nested list", () => {
      const { helpers, captured } = makeHelpers([
        { id: "t_X", kind: "tool", text: "{}", nested: [] },
      ]);
      helpers.setAgentNested("X", (n) => [...n, { toolName: "Bash", args: {}, running: true }]);
      expect(captured.current[0]?.nested).toEqual([{ toolName: "Bash", args: {}, running: true }]);
    });

    it("is a no-op (same reference) when no matching entry exists", () => {
      const { helpers, captured } = makeHelpers([{ id: "t_other", kind: "tool", text: "{}" }]);
      const before = captured.current;
      helpers.setAgentNested("X", (n) => [...n, { toolName: "Bash", args: {}, running: true }]);
      expect(captured.current).toBe(before);
    });

    it("keeps running nested tools while trimming old completed entries", () => {
      const oldCompleted = Array.from({ length: 30 }, (_, index) => ({
        toolName: `Old${index}`,
        args: {},
        running: false,
      }));
      const running = { toolName: "LongRunning", args: {}, running: true };
      const { helpers, captured } = makeHelpers([
        { id: "t_X", kind: "tool", text: "{}", nested: [...oldCompleted, running] },
      ]);
      helpers.setAgentNested("X", (n) => [...n, { toolName: "New", args: {}, running: false }]);
      const nested = captured.current[0]?.nested ?? [];
      expect(nested.length).toBe(24);
      expect(nested).toContainEqual(running);
      expect(nested.at(-1)).toEqual({ toolName: "New", args: {}, running: false });
    });

    it("keeps a running nested tool positioned before the retained tail", () => {
      const running = { toolName: "LongRunning", args: {}, running: true };
      const oldCompleted = Array.from({ length: 31 }, (_, index) => ({
        toolName: `Old${index}`,
        args: {},
        running: false,
      }));
      const { helpers, captured } = makeHelpers([
        { id: "t_X", kind: "tool", text: "{}", nested: [running, ...oldCompleted] },
      ]);
      helpers.setAgentNested("X", (n) => [...n, { toolName: "New", args: {}, running: false }]);
      const nested = captured.current[0]?.nested ?? [];
      expect(nested.length).toBe(24);
      expect(nested[0]).toEqual(running);
      expect(nested.at(-1)).toEqual({ toolName: "New", args: {}, running: false });
    });
  });

  describe("setAgentBackgrounded", () => {
    it("converts an Agent tool entry to a backgrounded settled entry", () => {
      const { helpers, captured } = makeHelpers([
        {
          id: "t_X",
          kind: "tool",
          title: "Agent",
          text: JSON.stringify({ description: "do thing", subagent_type: "explore" }),
        },
      ]);
      helpers.setAgentBackgrounded("X", "claude-opus-4-8");
      const entry = captured.current[0];
      expect(entry?.id).toBe("b_X");
      expect(entry?.isBackgrounded).toBe(true);
      expect(entry?.agentModel).toBe("claude-opus-4-8");
      expect(JSON.parse(entry?.text ?? "{}")).toEqual({
        status: "backgrounded",
        subagent_type: "explore",
        description: "do thing",
      });
    });

    it("captures command + description for a Bash tool entry", () => {
      const { helpers, captured } = makeHelpers([
        {
          id: "t_Y",
          kind: "tool",
          title: "Bash",
          text: JSON.stringify({ command: "ls -la", description: "list" }),
        },
      ]);
      helpers.setAgentBackgrounded("Y");
      expect(JSON.parse(captured.current[0]?.text ?? "{}")).toEqual({
        status: "backgrounded",
        command: "ls -la",
        description: "list",
      });
    });

    it("is a no-op (same reference) when no matching entry exists", () => {
      const { helpers, captured } = makeHelpers([{ id: "t_other", kind: "tool", text: "{}" }]);
      const before = captured.current;
      helpers.setAgentBackgrounded("X");
      expect(captured.current).toBe(before);
    });
  });
});
