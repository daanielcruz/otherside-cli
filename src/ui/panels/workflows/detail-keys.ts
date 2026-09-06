import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import type { DetailLevel } from "@/ui/panels/types.ts";

/**
 * What a press means inside the workflow detail — the tree of phases, the agents
 * of a phase, and one agent's card.
 *
 * The answer is a description rather than the act: what a key can do depends on
 * where the reader is standing and what the run is doing, and deciding that in
 * one place keeps the panel's side to applying the answer.
 */
export type WorkflowDetailAction =
  | { kind: "move-cursor"; delta: number }
  | { kind: "move-card"; delta: number }
  | { kind: "enter-agents" }
  | { kind: "enter-agent" }
  | { kind: "back" }
  | { kind: "toggle-prompt"; label: string }
  | { kind: "cycle-filter" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "stop" }
  | { kind: "retry-agent"; agentId: string }
  | { kind: "skip-agent"; agentId: string }
  | { kind: "save" };

export interface WorkflowDetailKeys {
  detailLevel: DetailLevel;
  /** The agent the cursor is on, taken from the filtered set the render drew. */
  agent: { label: string; agentId?: string | undefined } | undefined;
  /** Whether the phase under the cursor has agents to step into. */
  phaseHasAgents: boolean;
  workflowActive: boolean;
  canResume: boolean;
  /** The agent under the cursor is running and can be told to retry or give up. */
  canControlAgent: boolean;
  promptExpandable: boolean;
  hasScript: boolean;
}

export function workflowDetailKey(
  key: KeyEventData,
  keys: WorkflowDetailKeys,
): WorkflowDetailAction | undefined {
  const stepped = steppingKey(key, keys);
  if (stepped !== undefined) return stepped;
  // Taking a row and going in are one gesture on a tree. A level key stays the
  // level's even where there is nothing to go into, so it never falls through
  // and acts on the run instead.
  const level = panelKey(key);
  if (level === "confirm" || level === "forward") return drilledKey(keys);
  if (key.name === "left" || key.name === "escape") return { kind: "back" };
  return actedKey(key, keys);
}

/** Moving within where the reader stands: rows in a list, lines of a card. */
function steppingKey(
  key: KeyEventData,
  keys: WorkflowDetailKeys,
): WorkflowDetailAction | undefined {
  if (key.name === "down") return { kind: "move-cursor", delta: 1 };
  if (key.name === "up") return { kind: "move-cursor", delta: -1 };
  const delta = key.sequence === "j" ? 1 : key.sequence === "k" ? -1 : 0;
  if (delta === 0) return undefined;
  // A card is a document rather than a list, so the same keys scroll it.
  return keys.detailLevel === "agent"
    ? { kind: "move-card", delta }
    : { kind: "move-cursor", delta };
}

/** Where going in leads from each level, or nowhere. */
function drilledKey(keys: WorkflowDetailKeys): WorkflowDetailAction | undefined {
  if (keys.detailLevel === "agent") {
    // The card is the last level, so its only way in is the prompt it folds.
    return keys.promptExpandable && keys.agent
      ? { kind: "toggle-prompt", label: keys.agent.label }
      : undefined;
  }
  if (keys.detailLevel === "phases") {
    return keys.phaseHasAgents ? { kind: "enter-agents" } : undefined;
  }
  return keys.agent ? { kind: "enter-agent" } : undefined;
}

/** Doing something to the run, the phase, or the agent under the cursor. */
function actedKey(key: KeyEventData, keys: WorkflowDetailKeys): WorkflowDetailAction | undefined {
  const atPhases = keys.detailLevel === "phases";
  switch (key.sequence) {
    case " ":
      if (keys.workflowActive) return { kind: "pause" };
      return keys.canResume ? { kind: "resume" } : undefined;
    case "x":
      return keys.workflowActive && atPhases ? { kind: "stop" } : undefined;
    case "p":
      if (keys.detailLevel === "agent" && keys.promptExpandable && keys.agent) {
        return { kind: "toggle-prompt", label: keys.agent.label };
      }
      return keys.workflowActive && atPhases ? { kind: "pause" } : undefined;
    case "f":
      return keys.detailLevel === "agents" ? { kind: "cycle-filter" } : undefined;
    case "r": {
      const agentId = keys.canControlAgent ? keys.agent?.agentId : undefined;
      return agentId === undefined ? undefined : { kind: "retry-agent", agentId };
    }
    case "s": {
      const agentId = keys.canControlAgent ? keys.agent?.agentId : undefined;
      if (agentId !== undefined) return { kind: "skip-agent", agentId };
      // Skipping an agent claims the key first; saving is what it means elsewhere.
      return !keys.canControlAgent && keys.hasScript ? { kind: "save" } : undefined;
    }
    default:
      return undefined;
  }
}
