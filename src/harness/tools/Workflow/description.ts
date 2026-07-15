import {
  buildWorkflowMultiproviderToolSection,
  type ResolvedTierRoster,
} from "@/harness/core/tier-guidance.ts";
import tool from "@/harness/tools/Workflow/tool.json" with { type: "json" };

const BASE_PHASE_NOTE_TEXT =
  "The `meta` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required fields: `name`, `description`. Optional: `whenToUse` (shown in the workflow list), `phases`. Use the SAME phase titles in meta.phases as in phase() calls — titles are matched exactly; a phase() call with no matching meta entry just gets its own progress group. Add `model` to a phase entry when that phase uses a specific model override.";
const MULTIPROVIDER_PHASE_NOTE_TEXT = `${BASE_PHASE_NOTE_TEXT} Add \`tier\` to a phase entry only as a progress-display label when that phase uses a specific tier in its agent() calls.`;
const BASE_MODEL_OPTION_TEXT =
  "opts.model overrides the model for this agent call. Default to omitting it — the agent inherits the main-loop model (the resolved session model), which is almost always correct. Only set it when you're highly confident a different tier fits the task; when unsure, omit.";
const MULTIPROVIDER_MODEL_OPTION_TEXT = `${BASE_MODEL_OPTION_TEXT} opts.tier selects a model by multi-provider capability tier (\`general\`, \`warrior\`, or \`scout\`); the runtime spreads agents across that tier's distinct providers. A \`warrior\`/\`scout\` stage must carry a how-to brief in its prompt (steps, exact files, checks, output shape) — the tier picks the muscle, the prompt supplies the brain; reserve \`general\` stages for the thinking (plan, synthesize, judge). To pin a model from another provider, pass opts.provider together with opts.model; a bare model id stays on the inherited provider. An explicit pin bypasses tier routing.`;

export function baseWorkflowDescription(): string {
  return tool.description;
}

export interface WorkflowMultiproviderDescriptionInput {
  baseSignature: string;
  multiproviderSignature: string;
  roster: ResolvedTierRoster;
}

export function buildWorkflowMultiproviderDescription(
  input: WorkflowMultiproviderDescriptionInput,
): string {
  const withOptions = tool.description
    .replace(BASE_PHASE_NOTE_TEXT, MULTIPROVIDER_PHASE_NOTE_TEXT)
    .replace(input.baseSignature, input.multiproviderSignature)
    .replace(BASE_MODEL_OPTION_TEXT, MULTIPROVIDER_MODEL_OPTION_TEXT);
  const section = buildWorkflowMultiproviderToolSection(input.roster);
  return `${withOptions}\n\n${section}`;
}
