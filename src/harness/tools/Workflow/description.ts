import {
  buildWorkflowMultiproviderToolSection,
  type ResolvedTierRoster,
} from "@/harness/core/tier-guidance.ts";
import tool from "@/harness/tools/Workflow/tool.json" with { type: "json" };

const BASE_PHASE_NOTE_TEXT =
  "The `meta` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required fields: `name`, `description`. Optional: `whenToUse` (shown in the workflow list), `phases`. Use the SAME phase titles in meta.phases as in phase() calls — titles are matched exactly; a phase() call with no matching meta entry just gets its own progress group. Add `model` to a phase entry when that phase uses a specific model override.";
const MULTIPROVIDER_PHASE_NOTE_TEXT =
  "The `meta` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required fields: `name`, `description`. Optional: `whenToUse` (shown in the workflow list), `phases`. Use the SAME phase titles in meta.phases as in phase() calls — titles are matched exactly; a phase() call with no matching meta entry just gets its own progress group. Add `tier` to a phase entry only as a progress-display label when that phase uses a specific tier in its agent() calls.";
const BASE_MODEL_OPTION_TEXT =
  "opts.model overrides the model for this agent call. Default to omitting it — the agent inherits the main-loop model (the resolved session model), which is almost always correct. Only set it when you're highly confident a different tier fits the task; when unsure, omit.";
const DISABLED_MODEL_OPTION_TEXT =
  "opts.model selects a concrete model from the current provider. Default to omitting it — the agent inherits the current route. If the model is unavailable, the call fails instead of selecting another provider.";
const DEFAULT_MODEL_OPTION_TEXT =
  "opts.provider and opts.model select a concrete provider/model pair for this agent call. Default to omitting both — the agent inherits the current route. Explicit pins are literal: if unavailable, the call fails instead of substituting another route.";
const MULTIPROVIDER_MODEL_OPTION_TEXT =
  "opts.tier selects a model by multi-provider capability tier (`emperor`, `shogun`, `daimyo`, or `samurai`); the runtime routes agents across that tier's roster. A `daimyo`/`samurai` stage must carry a how-to brief in its prompt (steps, exact files, checks, output shape) — the tier picks the muscle, the prompt supplies the brain; `samurai` only on explicit choice for purely mechanical fan-out; reserve `emperor` stages for the thinking (plan, synthesize, judge) and `shogun` stages for complex execution inside a decided direction.";

export function baseWorkflowDescription(): string {
  return tool.description;
}

export function applyDisabledWorkflowModelGuidance(text: string): string {
  return text.replace(BASE_MODEL_OPTION_TEXT, DISABLED_MODEL_OPTION_TEXT);
}

export function applyDefaultWorkflowModelGuidance(text: string): string {
  return text.replace(BASE_MODEL_OPTION_TEXT, DEFAULT_MODEL_OPTION_TEXT);
}

export function replaceWorkflowAgentSignature(text: string, signature: string): string {
  return text.replace(/agent\(prompt: string, opts\?: \{[^}]+\}\)/, signature);
}

export interface WorkflowMultiproviderDescriptionInput {
  baseSignature: string;
  multiproviderSignature: string;
  roster: ResolvedTierRoster;
}

export function buildWorkflowMultiproviderDescription(
  input: WorkflowMultiproviderDescriptionInput,
): string {
  const withOptions = replaceWorkflowAgentSignature(
    tool.description.replace(BASE_PHASE_NOTE_TEXT, MULTIPROVIDER_PHASE_NOTE_TEXT),
    input.multiproviderSignature,
  ).replace(BASE_MODEL_OPTION_TEXT, MULTIPROVIDER_MODEL_OPTION_TEXT);
  const section = buildWorkflowMultiproviderToolSection(input.roster);
  return `${withOptions}\n\n${section}`;
}
