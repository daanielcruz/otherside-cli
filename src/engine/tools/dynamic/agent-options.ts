import type { OrchestrationMode } from "@/kernel/std/types/orchestration-mode.ts";
import { trimmedStringOrUndefined } from "@/kernel/std/value-guards.ts";

export interface ParsedAgentInput {
  subagentType: string | null;
  description?: string;
  prompt: string | null;
  runInBackground: boolean;
  tier?: string;
  model?: string;
  provider?: string;
  isolation?: "worktree" | "remote";
  validationError?: string;
}

interface AgentOptionDescriptor {
  /** Wire property name in the Agent tool inputSchema (Agent/tool.json). */
  name: string;
  /** Modes in which this option is exposed on the provider wire schema. */
  modes?: readonly OrchestrationMode[];
  parse: (raw: Record<string, unknown>, out: ParsedAgentInput) => void;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

// Single source of truth for the Agent tool's option set. Drives the handler
// parser (parseAgentInput) and the mode-specific fields the translator exposes.
// The wire schema itself stays in Agent/tool.json — the names here are pinned to
// its properties by agent.test.ts so the two cannot drift. Adding an option is
// one entry here plus its schema property, not a parser/schema hunt.
export const AGENT_OPTIONS: readonly AgentOptionDescriptor[] = [
  {
    name: "description",
    parse: (raw, out) => {
      if (typeof raw.description === "string") out.description = raw.description;
    },
  },
  {
    name: "prompt",
    parse: (raw, out) => {
      out.prompt = firstNonEmptyString(raw.prompt, raw.task_description, raw.description);
    },
  },
  {
    name: "subagent_type",
    parse: (raw, out) => {
      out.subagentType = trimmedStringOrUndefined(raw.subagent_type) ?? null;
    },
  },
  {
    name: "run_in_background",
    parse: (raw, out) => {
      if (typeof raw.run_in_background === "boolean") out.runInBackground = raw.run_in_background;
    },
  },
  {
    name: "tier",
    modes: ["feudalism"],
    parse: (raw, out) => {
      const tier = trimmedStringOrUndefined(raw.tier);
      if (tier !== undefined) out.tier = tier;
    },
  },
  {
    name: "model",
    modes: ["disabled", "default", "feudalism"],
    parse: (raw, out) => {
      const model = trimmedStringOrUndefined(raw.model);
      if (model !== undefined) out.model = model;
    },
  },
  {
    name: "provider",
    modes: ["default", "feudalism"],
    parse: (raw, out) => {
      const provider = trimmedStringOrUndefined(raw.provider);
      if (provider !== undefined) out.provider = provider;
    },
  },
  {
    name: "isolation",
    parse: (raw, out) => {
      if (raw.isolation === "worktree" || raw.isolation === "remote") {
        out.isolation = raw.isolation;
      }
    },
  },
];

export function orchestrationModeForAgentFields(mode: OrchestrationMode): readonly string[] {
  return AGENT_OPTIONS.filter(
    (option) => option.modes !== undefined && !option.modes.includes(mode),
  ).map((option) => option.name);
}

export function parseAgentInput(raw: unknown): ParsedAgentInput {
  const out: ParsedAgentInput = { subagentType: null, prompt: null, runInBackground: false };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  for (const option of AGENT_OPTIONS) option.parse(obj, out);
  return out;
}
