import { join } from "node:path";
import { getPermissionResolver } from "@/engine/agents/agent-context.ts";
import { dispatchSkillFork } from "@/engine/background/subagents/dispatcher.ts";
import { availableNames, get as getSkill } from "@/engine/skills/registry.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import {
  MEMORY_CONSOLIDATION_RULE,
  MEMORY_DATES_RULE,
  MEMORY_FRONTMATTER_TEMPLATE,
} from "@/harness/core/memory-guidance/format.ts";
import SkillSchema from "@/harness/tools/Skill/tool.json" with { type: "json" };
import { ephemeralAwareProjectPath } from "@/kernel/std/fs/paths.ts";
import { expandShellPrefix } from "@/kernel/std/proc/shell-prefix.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface SkillInput {
  skill?: unknown;
  args?: unknown;
}

export function getSkillToolDescription(opts: { lean?: boolean } = {}): string {
  return opts.lean ? SkillSchema.description.lean : SkillSchema.description.full;
}

export const Skill: ToolHandler = {
  schema: {
    name: SkillSchema.name,
    description: getSkillToolDescription({ lean: true }),
    inputSchema: SkillSchema.inputSchema,
  },
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as SkillInput;
    const name = typeof args.skill === "string" ? args.skill : null;
    if (!name) {
      return { tool_use_id: call.id, content: "missing `skill` argument", is_error: true };
    }
    if (name.length === 0 || name.includes("/") || name.includes("..")) {
      return {
        tool_use_id: call.id,
        content: `invalid skill name: ${name}`,
        is_error: true,
      };
    }
    const skill = getSkill(name);
    if (!skill) {
      const available = availableNames();
      return {
        tool_use_id: call.id,
        content: `unknown skill: ${name}\n\nAvailable: ${available.join(", ") || "(none registered)"}`,
        is_error: true,
      };
    }

    const userArgs = typeof args.args === "string" ? args.args : "";
    const rendered = renderSkillBody(skill.body);
    const body = await expandShellPrefix(rendered);

    if (skill.context === "fork") {
      const permissionResolver = getPermissionResolver();
      if (!permissionResolver) {
        return {
          tool_use_id: call.id,
          content: `skill ${skill.name} cannot run: no permission resolver in agent context`,
          is_error: true,
        };
      }
      const result = await dispatchSkillFork({
        ctx,
        name: skill.name,
        body,
        prompt: userArgs.length > 0 ? userArgs : `Run the ${skill.name} skill.`,
        permissionResolver,
      });
      const summary = renderSkillSummaryReminder(skill.name, result.output);
      return {
        tool_use_id: call.id,
        content: `${result.output}\n\n${summary}`,
        ...(result.isError ? { is_error: true } : {}),
      };
    }

    const header = `<command-name>${skill.name}</command-name>`;
    const argsBlock = userArgs.length > 0 ? `<command-args>${userArgs}</command-args>\n` : "";
    return {
      tool_use_id: call.id,
      content: `${header}\n${argsBlock}${body}`,
    };
  },
};

export function renderSkillSummaryReminder(skillName: string, output: string): string {
  const reportMatch = output.match(/Report:\s*(\/[^\s\n)]+)/);
  const reportPath = reportMatch ? reportMatch[1] : null;
  if (!reportPath) {
    return `<system-reminder>\nThe skill fork (${skillName}) finished. Your next assistant reply must be a single concise line summarizing the outcome for the user. If the fork emitted findings, include the severity tally and any artifact paths. Do not add prose before or after the summary line.\n</system-reminder>`;
  }
  return `<system-reminder>\nThe skill fork (${skillName}) finished and wrote a report to ${reportPath}.\n\nYour next assistant reply MUST be a single concise line in this exact shape (no prose before or after):\n\nDone · ${skillName} · <severity counts read from fork output> · Report: ${reportPath}\n\nUse the severity tally from the fork output verbatim (e.g. "1 critical · 2 high · 4 medium · 3 low"). Do not rephrase, expand, or add commentary.\n</system-reminder>`;
}

export function renderSkillBody(body: string): string {
  const project = ephemeralAwareProjectPath(process.cwd());
  const memoryDir = join(project, "memory");
  const transcriptDir = project;
  const reportsDir = join(project, "reports");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return body
    .replaceAll("{{MEMORY_ROOT}}", memoryDir)
    .replaceAll("{{TRANSCRIPT_DIR}}", transcriptDir)
    .replaceAll("{{REPORTS_DIR}}", reportsDir)
    .replaceAll("{{REPORT_TIMESTAMP}}", timestamp)
    .replaceAll("{{MEMORY_FORMAT}}", MEMORY_FRONTMATTER_TEMPLATE)
    .replaceAll("{{MEMORY_DATES_RULE}}", MEMORY_DATES_RULE)
    .replaceAll("{{MEMORY_CONSOLIDATION_RULE}}", MEMORY_CONSOLIDATION_RULE);
}
