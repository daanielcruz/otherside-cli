import { trimmedStringOrUndefined } from "@/kernel/std/value-guards.ts";

const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AGENT_NAME_ERROR =
  "name must begin with a letter or digit and may then include only letters, digits, underscores, or hyphens, up to 64 characters total";

export interface ParsedAgentInput {
  subagentType: string | null;
  description?: string;
  prompt: string | null;
  runInBackground: boolean;
  tier?: string;
  model?: string;
  provider?: string;
  name?: string;
  cwd?: string;
  isolation?: "worktree" | "remote";
  validationError?: string;
}

interface AgentOptionDescriptor {
  /** Wire property name in the Agent tool inputSchema (Agent/tool.json). */
  name: string;
  /** Stripped from the wire schema when multiprovider orchestration is off. */
  multiproviderOnly?: boolean;
  parse: (raw: Record<string, unknown>, out: ParsedAgentInput) => void;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

// Single source of truth for the Agent tool's option set. Drives the handler
// parser (parseAgentInput) and the multiprovider strip set
// (AGENT_MULTIPROVIDER_ONLY_FIELDS) the translator applies when orchestration is
// off. The wire schema itself stays in Agent/tool.json — the names here are
// pinned to its properties by agent.test.ts so the two cannot drift. Adding an
// option is one entry here plus its schema property, not a parser/strip-set hunt.
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
    multiproviderOnly: true,
    parse: (raw, out) => {
      const tier = trimmedStringOrUndefined(raw.tier);
      if (tier !== undefined) out.tier = tier;
    },
  },
  {
    name: "model",
    parse: (raw, out) => {
      const model = trimmedStringOrUndefined(raw.model);
      if (model !== undefined) out.model = model;
    },
  },
  {
    name: "provider",
    multiproviderOnly: true,
    parse: (raw, out) => {
      const provider = trimmedStringOrUndefined(raw.provider);
      if (provider !== undefined) out.provider = provider;
    },
  },
  {
    name: "name",
    parse: (raw, out) => {
      if (raw.name === undefined) return;
      if (typeof raw.name !== "string" || !AGENT_NAME_PATTERN.test(raw.name)) {
        out.validationError = AGENT_NAME_ERROR;
        return;
      }
      const name = raw.name;
      if (name === "main") {
        out.validationError =
          '"main" is reserved for the main conversation; SendMessage delivers there automatically';
        return;
      }
      out.name = name;
    },
  },
  {
    name: "cwd",
    parse: (raw, out) => {
      const cwd = trimmedStringOrUndefined(raw.cwd);
      if (cwd !== undefined) out.cwd = cwd;
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

export const AGENT_MULTIPROVIDER_ONLY_FIELDS: readonly string[] = AGENT_OPTIONS.filter(
  (option) => option.multiproviderOnly,
).map((option) => option.name);

export function parseAgentInput(raw: unknown): ParsedAgentInput {
  const out: ParsedAgentInput = { subagentType: null, prompt: null, runInBackground: false };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  for (const option of AGENT_OPTIONS) option.parse(obj, out);
  return out;
}
