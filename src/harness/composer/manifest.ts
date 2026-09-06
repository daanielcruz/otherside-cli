import type { LayerContext } from "@/harness/composer/injections.ts";
import type { LayerKind } from "@/harness/composer/types.ts";
import AUTONOMY_FABLE_SECTION from "@/harness/core/act-guidance/autonomy-fable.md" with {
  type: "text",
};
import ACT_GUIDANCE_SECTION from "@/harness/core/act-guidance/section.md" with { type: "text" };
import { availableModelsLayer } from "@/harness/core/available-models-guidance.ts";
import CONTEXT_MANAGEMENT_SECTION from "@/harness/core/context-management/section.md" with {
  type: "text",
};
import { envInfoLayer } from "@/harness/core/env-info.ts";
import { memoryGuidanceLayer } from "@/harness/core/memory-guidance/memory-guidance.ts";
import { operatorCoreLayer } from "@/harness/core/operator-core/operator-core.ts";
import { outputStyleLayer } from "@/harness/core/output-style.ts";
import PARALLEL_TASKS_SECTION from "@/harness/core/parallel-tasks/section.md" with { type: "text" };
import PRODUCT_GUARDRAILS_SECTION from "@/harness/core/product-guardrails/section.md" with {
  type: "text",
};
import {
  multiproviderGuidanceLayer,
  sessionGuidanceLayer,
} from "@/harness/core/session-guidance.ts";
import COMMUNICATING_LEAN_SECTION from "@/harness/core/text-output/communicating-lean.md" with {
  type: "text",
};
import COMMUNICATING_LEAN_FABLE_SECTION from "@/harness/core/text-output/communicating-lean-fable.md" with {
  type: "text",
};
import TEXT_OUTPUT_SECTION from "@/harness/core/text-output/section.md" with { type: "text" };
import { userContextLayer } from "@/harness/core/user-context.ts";
import { agentListingLayer } from "@/harness/reminders/agent-listing.ts";
import { deferredToolsLayer } from "@/harness/reminders/deferred-tools.ts";
import { investigateFirstMode } from "@/harness/reminders/investigate-first/investigate-first.ts";
import INVESTIGATE_FIRST_DYNAMIC_SECTION from "@/harness/reminders/investigate-first/section.md" with {
  type: "text",
};
import { renderMcpInstructions } from "@/harness/reminders/mcp-instructions.ts";
import { renderSkillsReminder } from "@/harness/reminders/reminders.ts";
import { bgSessionLayer, isBackgroundSession } from "@/harness/routines/bg-session.ts";
import { scratchpadLayer } from "@/harness/routines/scratchpad.ts";
import { isSessionMemoryEnabled } from "@/kernel/storage/memory/session-toggle.ts";

interface LayerDescriptorBase {
  name: string;
  kind: LayerKind;
  cache?: "1h" | "5m" | "global-1h";
  phase?: "static" | "dynamic";
  bundleKey?: string;
  // The FULL inclusion gate, hoisted out of render bodies. compose() skips the
  // layer when false. Absent = always considered (render may still return null).
  when?: (ctx: LayerContext) => boolean;
}

// Static layer: body is a build-time-embedded string (md asset import or const).
// NEVER an fs read at runtime. Optional {{token}} interpolation via applyTokens
// (same split/join mechanism as harness/tools — one interpolation SoT).
export interface StaticLayerDescriptor extends LayerDescriptorBase {
  prompt: string;
  tokens?: (ctx: LayerContext) => Record<string, string>;
  render?: never;
}

export interface DynamicLayerDescriptor extends LayerDescriptorBase {
  render: (ctx: LayerContext) => string | null;
  prompt?: never;
  tokens?: never;
}

export type LayerDescriptor = StaticLayerDescriptor | DynamicLayerDescriptor;

export const HARNESS_MANIFEST: readonly LayerDescriptor[] = [
  // 1
  {
    name: "operator-core",
    kind: "system",
    cache: "global-1h",
    phase: "static",
    render: operatorCoreLayer.render,
  },
  // 2
  {
    name: "product-guardrails",
    kind: "system",
    cache: "1h",
    phase: "static",
    prompt: PRODUCT_GUARDRAILS_SECTION,
  },
  // 3
  {
    name: "text-output",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    render: (ctx) =>
      ctx.lean
        ? (ctx.modelFamily === "fable"
            ? COMMUNICATING_LEAN_FABLE_SECTION
            : COMMUNICATING_LEAN_SECTION
          ).trimEnd()
        : TEXT_OUTPUT_SECTION.trimEnd(),
  },
  // 5
  {
    name: "investigate-first",
    kind: "system",
    cache: "1h",
    phase: "static",
    when: (ctx) => investigateFirstMode(ctx.model) !== "off",
    prompt: INVESTIGATE_FIRST_DYNAMIC_SECTION,
  },
  // 6
  {
    name: "session-guidance",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    render: sessionGuidanceLayer.render,
  },
  {
    name: "multiprovider-guidance",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    render: multiproviderGuidanceLayer.render,
  },
  {
    name: "parallel-tasks",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    when: (ctx) => ctx.config?.parallelTasks === true,
    prompt: PARALLEL_TASKS_SECTION,
  },
  // 7
  {
    name: "available-models",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    render: availableModelsLayer.render,
  },
  // 8
  {
    name: "memory-guidance",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    when: () => isSessionMemoryEnabled(),
    render: memoryGuidanceLayer.render,
  },
  // 9
  {
    name: "env-info",
    kind: "system",
    phase: "dynamic",
    render: envInfoLayer.render,
  },
  // 10
  {
    name: "language",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    when: (ctx) => !!ctx.config?.language?.trim(),
    prompt:
      '# Language\nAlways respond in {{language}}. Use {{language}} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.\nMaintain full orthographic correctness for {{language}}, including all required diacritical marks, accents, and special characters. Never substitute accented characters with their ASCII equivalents (e.g., never write "nao" for "não", "fur" for "für", or "loeschen" for "löschen").',
    tokens: (ctx) => ({ "{{language}}": ctx.config.language?.trim() ?? "" }),
  },
  // 11
  {
    name: "output-style",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    when: (ctx) => ctx.outputStyle !== null,
    render: outputStyleLayer.render,
  },
  // 12
  {
    name: "bg-session",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    when: () => isBackgroundSession() && !!process.env.OTHERSIDE_JOB_DIR,
    render: bgSessionLayer.render,
  },
  // 13
  {
    name: "scratchpad",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    when: () => !isBackgroundSession(),
    render: scratchpadLayer.render,
  },
  // 14
  {
    name: "context-management",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    prompt: CONTEXT_MANAGEMENT_SECTION,
  },
  // 15
  {
    name: "act-guidance",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    prompt: ACT_GUIDANCE_SECTION,
  },
  {
    name: "autonomy",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    when: (ctx) => ctx.modelFamily === "fable",
    prompt: AUTONOMY_FABLE_SECTION,
  },
  // 16
  {
    name: "git-status",
    kind: "system",
    cache: "1h",
    phase: "dynamic",
    when: (ctx) => !!ctx.gitStatus,
    prompt: "gitStatus: {{gitStatus}}",
    tokens: (ctx) => ({ "{{gitStatus}}": ctx.gitStatus ?? "" }),
  },
  // 17
  {
    name: "deferred-tools",
    kind: "mid-system",
    when: (ctx) => ctx.emitDeferredReminder,
    render: deferredToolsLayer.render,
  },
  // 18
  {
    name: "agent-listing",
    kind: "mid-system",
    when: (ctx) => !!ctx.emitAgentListing && (ctx.agentRows ?? []).length > 0,
    render: agentListingLayer.render,
  },
  // 19
  {
    name: "skills",
    kind: "mid-system",
    when: (ctx) => (ctx.skillListing ?? []).length > 0,
    render: (ctx) => renderSkillsReminder(ctx.skillListing ?? []).trim(),
  },
  // 20
  {
    name: "mcp-instructions",
    kind: "mid-system",
    when: (ctx) => (ctx.mcpInstructionBlocks ?? []).length > 0,
    render: (ctx) => renderMcpInstructions(ctx.mcpInstructionBlocks ?? []),
  },
  // 21
  {
    name: "user-context",
    kind: "user",
    bundleKey: "user-context",
    when: (ctx) => !!ctx.currentDate || (ctx.memorySection ?? null) !== null,
    render: userContextLayer.render,
  },
  // 22
  {
    name: "injections",
    kind: "system",
    phase: "dynamic",
    when: (ctx) => ctx.injections.peek().length > 0,
    render: (ctx) => ctx.injections.drain().join("\n\n"),
  },
];
