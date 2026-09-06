import type { WorkflowAgentStatus } from "@/engine/background/workflows/runtime/store/types.ts";
import type { AgentDisplayStatus } from "@/ui/chrome/progress/glyphs.ts";
import { agentStatusLabel } from "@/ui/panels/workflows/items.ts";

/** `all` shows every agent; the rest narrow the list to one display status. */
export type AgentFilter = "all" | AgentDisplayStatus;

/**
 * The order the filter key steps through. `all` leads so one press away from the
 * last status returns to the whole list rather than stranding the reader inside a
 * narrowed view.
 */
export const AGENT_FILTER_ORDER: readonly AgentFilter[] = [
  "all",
  "running",
  "queued",
  "failed",
  "done",
  "skipped",
  "interrupted",
];

const AGENT_FILTER_LABELS: Record<AgentFilter, string> = {
  all: "all",
  queued: "queued",
  running: "running",
  done: "completed",
  failed: "failed",
  skipped: "skipped",
  interrupted: "stopped",
};

/** The word the footer shows for an active filter; `all` is the absence of one. */
export function agentFilterLabel(filter: AgentFilter): string | undefined {
  return filter === "all" ? undefined : AGENT_FILTER_LABELS[filter];
}

/**
 * The next filter that would actually match something. A status no agent in this
 * phase carries is skipped, so the key never lands on an empty list — and if
 * nothing matches at all it comes to rest on `all`.
 */
export function nextAgentFilter(input: {
  current: AgentFilter;
  agents: readonly WorkflowAgentStatus[];
  workflowActive: boolean;
}): AgentFilter {
  const { current, agents, workflowActive } = input;
  const present = new Set(agents.map((agent) => agentStatusLabel({ agent, workflowActive })));
  const start = AGENT_FILTER_ORDER.indexOf(current);
  for (let step = 1; step <= AGENT_FILTER_ORDER.length; step++) {
    const candidate = AGENT_FILTER_ORDER[(start + step) % AGENT_FILTER_ORDER.length];
    if (candidate === undefined) continue;
    if (candidate === "all" || present.has(candidate)) return candidate;
  }
  return "all";
}

export function filterAgents(input: {
  agents: readonly WorkflowAgentStatus[];
  filter: AgentFilter;
  workflowActive: boolean;
}): readonly WorkflowAgentStatus[] {
  const { agents, filter, workflowActive } = input;
  if (filter === "all") return agents;
  return agents.filter((agent) => agentStatusLabel({ agent, workflowActive }) === filter);
}
