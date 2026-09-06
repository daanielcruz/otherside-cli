import { DESIGN_AGENT_TOOLS, GenerateImageDesignTool } from "@/design/capabilities/agent-tools.ts";
import {
  CreateDesignTool,
  ReadDesignTool,
  UpdateDesignTool,
} from "@/design/capabilities/canvas-tools.ts";
import { ReadyForVerificationTool } from "@/design/capabilities/verification-tools.ts";
import { resolveImageGeneratorProvider } from "@/engine/providers/image-generation.ts";
import { Bash } from "@/engine/tools/builtins/bash.ts";
import { Read } from "@/engine/tools/builtins/read/read.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import { loadConfig } from "@/kernel/config/config.ts";
import { hasCredentialSync } from "@/kernel/storage/credentials.ts";

const DESIGN_WORKER_TOOLS: readonly ToolHandler[] = [
  CreateDesignTool,
  ReadDesignTool,
  UpdateDesignTool,
  ReadyForVerificationTool,
  ...DESIGN_AGENT_TOOLS,
];
const DESIGN_WORKER_TOOL_NAMES = DESIGN_WORKER_TOOLS.map((tool) => tool.schema.name);
export const DESIGN_ALLOW_SET = new Set([...DESIGN_WORKER_TOOL_NAMES, "ToolSearch"]);
const DESIGN_WORKER_TOOL_DECLARATIONS = DESIGN_WORKER_TOOLS.map((tool) => ({
  name: tool.schema.name,
  description: tool.schema.description,
  input_schema: tool.schema.inputSchema,
}));

export type DesignToolDeclaration = (typeof DESIGN_WORKER_TOOL_DECLARATIONS)[number];

export interface DesignToolset {
  scopedTools: readonly ToolHandler[];
  declarations: DesignToolDeclaration[];
  allowSet: Set<string>;
}

export function buildDesignDirectives(opts: {
  codebaseAttached: boolean;
  medium?: string | undefined;
  activeSkills?: readonly string[] | undefined;
  targetScreen?: string | undefined;
}): string {
  const lines: string[] = [];
  if (opts.medium && opts.medium !== "auto") {
    lines.push(
      `Selected medium: ${opts.medium}. Call read_design_skill once with name "${opts.medium}" before building (skip if already loaded). Build that medium; don't ask which one to make.`,
    );
  }
  if (opts.activeSkills && opts.activeSkills.length > 0) {
    const extra = opts.activeSkills.filter((skill) => skill !== opts.medium);
    if (extra.length > 0) {
      lines.push(
        `Also load these attached skills via read_design_skill (once each, skip if loaded): ${extra.join(", ")}. Apply them with the medium methodology.`,
      );
    }
  }
  if (opts.codebaseAttached) {
    lines.push(
      "A codebase is attached: you have Read and Bash. Inspect the working directory (ls, find, grep, read key files) to identify the framework, structure, and existing styles or components before designing. Never ask for facts you can discover yourself. If real product decisions remain, call ask_questions once with one titled form and wait for the returned answers before planning or building; skip it for small edits, follow-ups, and briefs that already settle the decisions.",
    );
    lines.push(
      "After creating the initial design, request a visual review or verify your work if possible. Check your work against the prompt and do a targeted update_design to fix any unpolished aspects or bugs.",
    );
  }
  if (opts.targetScreen) {
    lines.push(
      `The user has the screen "${opts.targetScreen}" selected — apply this request to that screen with update_design unless they name another screen.`,
    );
  }
  if (lines.length === 0) return "";
  return `<system-reminder>\n${lines.join("\n")}\n</system-reminder>\n\n`;
}

async function generateImageAvailable(provider: string): Promise<boolean> {
  const config = await loadConfig();
  const generator = resolveImageGeneratorProvider(config.imageGenProvider, provider);
  return generator !== null && hasCredentialSync(generator);
}

export async function resolveDesignToolset(
  provider: string,
  codebaseAttached: boolean,
): Promise<DesignToolset> {
  const allowSet = new Set(DESIGN_ALLOW_SET);
  allowSet.add("ask_questions");
  // Codebase turns expose Read/Bash as first-class declarations — deferred
  // ToolSearch alone left Gemini looping on select:Read,Bash without calling them.
  const baseTools: ToolHandler[] = codebaseAttached
    ? [...DESIGN_WORKER_TOOLS, Read, Bash]
    : [...DESIGN_WORKER_TOOLS];
  if (codebaseAttached) {
    allowSet.add("Read");
    allowSet.add("Bash");
  }
  if (!(await generateImageAvailable(provider))) {
    return {
      scopedTools: baseTools,
      declarations: baseTools.map((tool) => ({
        name: tool.schema.name,
        description: tool.schema.description,
        input_schema: tool.schema.inputSchema,
      })),
      allowSet,
    };
  }
  const scopedTools = [...baseTools, GenerateImageDesignTool];
  allowSet.add(GenerateImageDesignTool.schema.name);
  return {
    scopedTools,
    declarations: scopedTools.map((tool) => ({
      name: tool.schema.name,
      description: tool.schema.description,
      input_schema: tool.schema.inputSchema,
    })),
    allowSet,
  };
}
