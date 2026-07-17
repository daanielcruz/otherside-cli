import { describe, expect, test } from "bun:test";
import type { SubagentDef } from "@/engine/agents/registry.ts";
import { Ink } from "@/ink";
import { computeListWindow } from "@/kernel/std/list-window.ts";
import { pickerMaxHeight } from "@/ui/chrome/picker-geometry.ts";
import {
  AgentLibraryPicker,
  LibraryPane,
  orderedAgentLibrary,
  pageAgentLibraryIndex,
  visibleAgentLibraryRows,
} from "@/ui/panels/agents/index.tsx";
import { type OverlayRegistryProps, renderOverlay } from "@/ui/panels/registry.tsx";
import { TerminalEmulator } from "@/ui/transcript/__tests__/terminal-emulator.ts";

function createStdout(term: TerminalEmulator): NodeJS.WriteStream {
  const listeners = new Map<string, Set<() => void>>();
  const stream = {
    get columns() {
      return term.columns;
    },
    get rows() {
      return term.rows;
    },
    isTTY: true,
    write(chunk: unknown) {
      term.write(String(chunk));
      return true;
    },
    on(event: string, callback: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(callback);
      return stream;
    },
    off(event: string, callback: () => void) {
      listeners.get(event)?.delete(callback);
      return stream;
    },
  };
  return stream as unknown as NodeJS.WriteStream;
}

function createStdin(): NodeJS.ReadStream {
  const stream = {
    isTTY: false,
    isRaw: false,
    setRawMode() {},
    listeners: () => [],
    addListener() {
      return stream;
    },
    removeListener() {
      return stream;
    },
    on() {
      return stream;
    },
    off() {
      return stream;
    },
  };
  return stream as unknown as NodeJS.ReadStream;
}

function renderAgents(rows: number, agents: SubagentDef[], selected?: number) {
  const term = new TerminalEmulator(120, rows);
  const stdout = createStdout(term);
  const ink = new Ink({
    stdout,
    stdin: createStdin(),
    stderr: createStdout(new TerminalEmulator(120, rows)),
    exitOnCtrlC: true,
    patchConsole: false,
  });
  const library = orderedAgentLibrary(agents);
  const node =
    selected === undefined ? (
      <AgentLibraryPicker
        agents={library}
        selected={0}
        visibleRows={visibleAgentLibraryRows(rows)}
        providerShortKey="test"
      />
    ) : (
      <LibraryPane
        agents={library}
        selected={selected}
        visibleRows={visibleAgentLibraryRows(rows)}
        providerShortKey="test"
      />
    );
  ink.render(node);
  ink.onRender();
  return {
    term,
    cleanup: () => {
      (stdout as unknown as { isTTY: boolean }).isTTY = false;
      ink.unmount(null);
    },
  };
}

function fixtureAgents(): SubagentDef[] {
  return Array.from({ length: 62 }, (_, index) => {
    const scope = index < 21 ? "user" : index < 42 ? "project" : "builtin";
    const ordinal = String(index + 1).padStart(2, "0");
    return {
      id: `agent-${ordinal}`,
      name: `Agent ${ordinal}`,
      description: `Description for agent ${ordinal}`,
      body: "",
      tools: null,
      disallowedTools: null,
      model: { test: { model: "test-model" } },
      background: true,
      scope,
    };
  });
}

function nonEmptyLineCount(term: TerminalEmulator): number {
  return term
    .allText()
    .split("\n")
    .filter((line) => line.length > 0).length;
}

describe("agents library picker", () => {
  const agents = fixtureAgents();

  test("centers and bounds 62-agent windows at each picker height", () => {
    const cases = [
      {
        terminalRows: 20,
        visible: 1,
        centered: { from: 31, to: 32, size: 1, above: 31, below: 30 },
        tail: { from: 61, to: 62, size: 1, above: 61, below: 0 },
      },
      {
        terminalRows: 30,
        visible: 7,
        centered: { from: 28, to: 35, size: 7, above: 28, below: 27 },
        tail: { from: 55, to: 62, size: 7, above: 55, below: 0 },
      },
      {
        terminalRows: 50,
        visible: 20,
        centered: { from: 21, to: 41, size: 20, above: 21, below: 21 },
        tail: { from: 42, to: 62, size: 20, above: 42, below: 0 },
      },
    ];

    for (const entry of cases) {
      expect(visibleAgentLibraryRows(entry.terminalRows)).toBe(entry.visible);
      expect(
        computeListWindow({ cursor: 31, total: 62, size: entry.visible, anchor: "center" }),
      ).toEqual(entry.centered);
      expect(
        computeListWindow({ cursor: 61, total: 62, size: entry.visible, anchor: "center" }),
      ).toEqual(entry.tail);
    }
    expect(pageAgentLibraryIndex(31, 62, 1, 7)).toBe(38);
    expect(pageAgentLibraryIndex(61, 62, 1, 20)).toBe(61);
  });

  test("renders a bounded library-only picker at responsive terminal heights", () => {
    for (const rows of [20, 30, 50]) {
      const { term, cleanup } = renderAgents(rows, agents);
      try {
        const output = term.visibleText();
        expect(nonEmptyLineCount(term)).toBeLessThanOrEqual(pickerMaxHeight(rows));
        expect(output).toContain(`Agents (1 of ${agents.length})`);
        expect(output).toContain("↑↓ navigate · PgUp/PgDn page · Esc close");
        expect(output).not.toContain("Running (");
        expect(output).toContain("User");
        expect(output).toContain("· background");
        expect(output).toContain("Description for agent 01");
      } finally {
        cleanup();
      }
    }
  });

  test("renders only the tail window for entry 62", () => {
    const { term, cleanup } = renderAgents(50, agents, 61);
    try {
      const output = term.visibleText();
      expect(output).toContain("↑ 42 more above");
      expect(output).toContain("Agent 62");
      expect(output).toContain("Description for agent 62");
      expect(output).not.toContain("Agent 01");
      expect(output).not.toContain("Agent 42");
    } finally {
      cleanup();
    }
  });

  test("registry leaves background tasks out of the agents overlay props", () => {
    const overlay = renderOverlay("agents", {
      broker: { read: () => ({ provider: "test" }) },
      onClose: () => {},
      tasks: [{ id: "background-task" }],
    } as unknown as OverlayRegistryProps);
    const props = overlay?.props as { providerShortKey?: string; tasks?: unknown };

    expect(props.providerShortKey).toBe("test");
    expect(props).not.toHaveProperty("tasks");
  });
});
