import { cloneWorkflowBoundaryValue } from "@/engine/background/workflows/runtime/sandbox/clone.ts";
import { TIER_NAMES } from "@/engine/model/tier/names.ts";
import type { OrchestrationMode } from "@/kernel/config/orchestration-mode.ts";
import { EFFORT_LEVEL_VALUES, type EffortLevel } from "@/kernel/std/types/effort.ts";
import { trimmedStringOrUndefined } from "@/kernel/std/value-guards.ts";

export interface ParsedAgentInput {
  subagentType: string | null;
  description?: string;
  prompt: string | null;
  runInBackground: boolean;
  tier?: string;
  name?: string;
  isolation?: "worktree";
}

export interface WorkflowAgentOptions {
  label?: string;
  phase?: string;
  schema?: unknown;
  model?: string;
  effort?: EffortLevel;
  provider?: string;
  tier?: string;
  diversify?: boolean;
  agentType?: string;
  isolation?: "worktree";
}

interface WorkflowAgentOptionDescriptor {
  name: keyof WorkflowAgentOptions;
  /** TypeScript value rendered in the agent() signature shown to the model. */
  signatureType: string;
  /** Modes in which this option is exposed in the agent() signature. */
  modes?: readonly OrchestrationMode[];
  /** Participates in the workflow-resume agent cache key. */
  cacheKeyParticipating?: boolean;
  parse: (raw: Record<string, unknown>, out: WorkflowAgentOptions) => void;
}

const TIER_SIGNATURE_TYPE = TIER_NAMES.map((tier) => `'${tier}'`).join(" | ");

type WorkflowStringOptionName = "label" | "phase" | "model" | "provider" | "tier" | "agentType";

function readNonEmptyString(
  name: WorkflowStringOptionName,
): WorkflowAgentOptionDescriptor["parse"] {
  return (raw, out) => {
    const value = trimmedStringOrUndefined(raw[name]);
    if (value !== undefined) out[name] = value;
  };
}

// Single source of truth for the workflow agent() option set. Drives the parser
// (readAgentOptions), the resume cache key (WORKFLOW_AGENT_CACHE_KEYS), and the
// agent() signature rendered into the Workflow tool description. Adding an option
// is one entry here — not an edit across parser, cache-key, and description.
export const WORKFLOW_AGENT_OPTIONS: readonly WorkflowAgentOptionDescriptor[] = [
  { name: "label", signatureType: "string", parse: readNonEmptyString("label") },
  { name: "phase", signatureType: "string", parse: readNonEmptyString("phase") },
  {
    name: "schema",
    signatureType: "object",
    cacheKeyParticipating: true,
    parse: (raw, out) => {
      if (raw.schema !== undefined) out.schema = cloneWorkflowBoundaryValue(raw.schema);
    },
  },
  {
    name: "model",
    signatureType: "string",
    modes: ["disabled", "default"],
    cacheKeyParticipating: true,
    parse: readNonEmptyString("model"),
  },
  {
    name: "effort",
    signatureType: "string",
    cacheKeyParticipating: true,
    parse: (raw, out) => {
      if (EFFORT_LEVEL_VALUES.some((effort) => effort === raw.effort)) {
        out.effort = raw.effort as EffortLevel;
      }
    },
  },
  {
    name: "provider",
    signatureType: "string",
    modes: ["default"],
    cacheKeyParticipating: true,
    parse: readNonEmptyString("provider"),
  },
  {
    name: "tier",
    signatureType: TIER_SIGNATURE_TYPE,
    modes: ["feudalism"],
    cacheKeyParticipating: true,
    parse: readNonEmptyString("tier"),
  },
  {
    name: "diversify",
    signatureType: "boolean",
    modes: ["feudalism"],
    cacheKeyParticipating: true,
    parse: (raw, out) => {
      if (typeof raw.diversify === "boolean") out.diversify = raw.diversify;
    },
  },
  {
    name: "isolation",
    signatureType: "'worktree'",
    cacheKeyParticipating: true,
    parse: (raw, out) => {
      if (raw.isolation === "worktree") out.isolation = "worktree";
    },
  },
  {
    name: "agentType",
    signatureType: "string",
    cacheKeyParticipating: true,
    parse: readNonEmptyString("agentType"),
  },
];

export const WORKFLOW_AGENT_CACHE_KEYS: readonly (keyof WorkflowAgentOptions)[] =
  WORKFLOW_AGENT_OPTIONS.filter((option) => option.cacheKeyParticipating).map(
    (option) => option.name,
  );

export function renderWorkflowAgentSignature(
  orchestrationMode: OrchestrationMode = "disabled",
): string {
  const fields = WORKFLOW_AGENT_OPTIONS.filter(
    (option) => option.modes === undefined || option.modes.includes(orchestrationMode),
  )
    .map((option) => `${option.name}?: ${option.signatureType}`)
    .join(", ");
  return `agent(prompt: string, opts?: {${fields}})`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readAgentOptions(raw: unknown): WorkflowAgentOptions {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: WorkflowAgentOptions = {};
  for (const option of WORKFLOW_AGENT_OPTIONS) option.parse(obj, out);
  return out;
}
