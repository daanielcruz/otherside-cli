import type { WorkflowPhaseDescriptor } from "@/engine/background/workflows/runtime/parser/types.ts";
import type {
  WorkflowAgentProgress,
  WorkflowProgressEntry,
} from "@/engine/background/workflows/runtime/store/types.ts";
import type { WorkflowTaskStatus } from "@/kernel/channels/workflow-tasks.ts";

const SYNTHETIC_PHASE_TITLE = "Agents";
const MIDDOT = " · ";
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const PAD_WIDTH = 2;
const PAD_CHAR = "0";

export interface MergedPhase {
  title: string;
  status: "not-started" | "running" | "done" | "failed";
  agents: WorkflowAgentProgress[];
  doneCount: number;
  totalCount: number;
  tokens: number;
  durationMs: number;
}

interface PhaseInfo {
  title: string;
  kind?: string;
}

interface CollectedProgress {
  agents: WorkflowAgentProgress[];
  phaseTitles: Map<number, PhaseInfo>;
}

interface PhaseGroup {
  phaseIndex: number;
  title: string;
  kind?: string;
  agents: WorkflowAgentProgress[];
}

function pluralAgents(count: number): string {
  return count === 1 ? "agent" : "agents";
}

function collectWorkflowProgress(entries: WorkflowProgressEntry[]): CollectedProgress {
  const agents = new Map<number, WorkflowAgentProgress>();
  const phaseTitles = new Map<number, PhaseInfo>();
  for (const entry of entries) {
    if (entry.type === "workflow_agent") {
      agents.set(entry.index, entry);
      continue;
    }
    if (entry.type === "workflow_phase") {
      phaseTitles.set(entry.index, {
        title: entry.title,
        ...(entry.kind ? { kind: entry.kind } : {}),
      });
    }
  }
  return {
    agents: [...agents.values()].sort((a, b) => a.index - b.index),
    phaseTitles,
  };
}

function createPhaseGroup(input: { phaseIndex: number; info?: PhaseInfo }): PhaseGroup {
  const { phaseIndex, info } = input;
  return {
    phaseIndex,
    title: info?.title ?? `Phase ${phaseIndex}`,
    agents: [],
    ...(info?.kind ? { kind: info.kind } : {}),
  };
}

function groupAgentsByPhase(input: {
  agents: WorkflowAgentProgress[];
  phaseTitles: Map<number, PhaseInfo>;
}): PhaseGroup[] | null {
  const { agents, phaseTitles } = input;
  if (!agents.some((agent) => !!agent.phaseTitle)) return null;
  const indexByTitle = new Map<string, number>();
  for (const [index, info] of phaseTitles) {
    const key = normalizeTitle(info.title);
    if (!indexByTitle.has(key)) indexByTitle.set(key, index);
  }
  let nextIndex = phaseTitles.size;
  const groups = new Map<string, PhaseGroup>();
  for (const agent of agents) {
    const title = agent.phaseTitle ?? SYNTHETIC_PHASE_TITLE;
    const key = normalizeTitle(title);
    let group = groups.get(key);
    if (!group) {
      const registeredIndex = indexByTitle.get(key);
      const phaseIndex = registeredIndex ?? nextIndex++;
      const info = (registeredIndex !== undefined
        ? phaseTitles.get(registeredIndex)
        : undefined) ?? { title };
      group = createPhaseGroup({ phaseIndex, info });
      groups.set(key, group);
    }
    group.agents.push(agent);
  }
  return [...groups.values()].sort((a, b) => a.phaseIndex - b.phaseIndex);
}

function buildMergedFromGroup(group: PhaseGroup): MergedPhase {
  const doneCount = group.agents.filter((agent) => agent.state === "done").length;
  const errorCount = group.agents.filter(
    (agent) => agent.state === "error" && agent.stopped !== true,
  ).length;
  const stoppedCount = group.agents.filter(
    (agent) => agent.state === "error" && agent.stopped === true,
  ).length;
  const totalCount = group.agents.length;
  const complete = doneCount + errorCount + stoppedCount === totalCount && totalCount > 0;
  let tokens = 0;
  let earliestStart = Number.POSITIVE_INFINITY;
  let latestProgress = 0;
  for (const agent of group.agents) {
    tokens += agent.tokens ?? 0;
    if (agent.startedAt < earliestStart) earliestStart = agent.startedAt;
    if (agent.lastProgressAt > latestProgress) latestProgress = agent.lastProgressAt;
  }
  const durationMs = earliestStart < Number.POSITIVE_INFINITY ? latestProgress - earliestStart : 0;
  return {
    title: group.title,
    status: complete ? (errorCount > 0 ? "failed" : "done") : "running",
    agents: group.agents,
    doneCount,
    totalCount,
    tokens,
    durationMs,
  };
}

function buildMergedFromDeclared(title: string): MergedPhase {
  return {
    title,
    status: "not-started",
    agents: [],
    doneCount: 0,
    totalCount: 0,
    tokens: 0,
    durationMs: 0,
  };
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().trim();
}

function mergeDeclaredWithProgress(input: {
  declared: WorkflowPhaseDescriptor[] | undefined;
  groups: PhaseGroup[];
}): MergedPhase[] {
  const { declared, groups } = input;
  const claimed = new Set<PhaseGroup>();
  const merged: MergedPhase[] = [];
  function match(title: string): PhaseGroup | undefined {
    const want = normalizeTitle(title);
    for (const group of groups) {
      if (claimed.has(group)) continue;
      const have = normalizeTitle(group.title);
      if (want === have || have.startsWith(want) || want.startsWith(have)) {
        claimed.add(group);
        return group;
      }
    }
    return undefined;
  }
  for (const phase of declared ?? []) {
    const group = match(phase.title);
    merged.push(group ? buildMergedFromGroup(group) : buildMergedFromDeclared(phase.title));
  }
  for (const group of groups) {
    if (!claimed.has(group)) merged.push(buildMergedFromGroup(group));
  }
  return merged;
}

export function buildMergedPhases(input: {
  workflowProgress: WorkflowProgressEntry[];
  phases?: WorkflowPhaseDescriptor[];
}): MergedPhase[] {
  const { workflowProgress, phases } = input;
  const progress = collectWorkflowProgress(workflowProgress);
  const groups =
    groupAgentsByPhase({ agents: progress.agents, phaseTitles: progress.phaseTitles }) ?? [];
  const merged = mergeDeclaredWithProgress({ declared: phases, groups });
  if (merged.length === 0 && progress.agents.length > 0) {
    return [
      buildMergedFromGroup({
        phaseIndex: 0,
        title: SYNTHETIC_PHASE_TITLE,
        agents: progress.agents,
      }),
    ];
  }
  return merged;
}

export function computeWorkflowAgentCounts(input: {
  phases: MergedPhase[];
  declaredAgentCount: number;
}): { doneAgents: number; totalAgents: number } {
  const { phases, declaredAgentCount } = input;
  let doneAgents = 0;
  let totalAgents = 0;
  for (const phase of phases) {
    doneAgents += phase.doneCount;
    totalAgents += phase.totalCount;
  }
  return {
    doneAgents,
    totalAgents: Math.max(declaredAgentCount, totalAgents, doneAgents),
  };
}

function statusSuffix(status: WorkflowTaskStatus): string {
  if (status === "completed") return `${MIDDOT}done`;
  if (status === "killed") return `${MIDDOT}stopped`;
  if (status === "paused") return `${MIDDOT}paused`;
  if (status === "failed") return `${MIDDOT}failed`;
  return "";
}

function formatElapsedCompact(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  if (totalSeconds < SECONDS_PER_MINUTE) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  if (totalMinutes < MINUTES_PER_HOUR) {
    return `${totalMinutes}m${String(totalSeconds % SECONDS_PER_MINUTE).padStart(PAD_WIDTH, PAD_CHAR)}s`;
  }
  const totalHours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  if (totalHours < HOURS_PER_DAY) {
    return `${totalHours}h${String(totalMinutes % MINUTES_PER_HOUR).padStart(PAD_WIDTH, PAD_CHAR)}m`;
  }
  return `${Math.floor(totalHours / HOURS_PER_DAY)}d${String(totalHours % HOURS_PER_DAY).padStart(PAD_WIDTH, PAD_CHAR)}h`;
}

export function buildWorkflowHeader(input: {
  name: string;
  description: string;
  status: WorkflowTaskStatus;
  counts: { doneAgents: number; totalAgents: number };
  elapsedMs: number;
}): { name: string; subtext: string; stats: string } {
  const { name, description, status, counts, elapsedMs } = input;
  const suffix = statusSuffix(status);
  const stats = `${counts.doneAgents}/${counts.totalAgents} ${pluralAgents(counts.totalAgents)}${MIDDOT}${formatElapsedCompact(elapsedMs)}${suffix}`;
  return { name, subtext: description, stats };
}
