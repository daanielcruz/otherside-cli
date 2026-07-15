import { existsSync } from "node:fs";
import { platform as osPlatform, release as osRelease, type as osType } from "node:os";
import { join } from "node:path";
import { findModel } from "@/engine/model/catalog.ts";
import { knowledgeCutoffFor } from "@/engine/model/facts/knowledge-cutoff.ts";
import { scratchpadDirFor } from "@/harness/routines/scratchpad.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

// The generic guidance every subagent carries, folded into its single cached
// system block ahead of the runtime environment tail.
export const SUBAGENT_NOTES = [
  "Notes:",
  "- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.",
  "- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.",
  "- For clear communication with the user the assistant MUST avoid using emojis.",
  '- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.',
  "- Do NOT Write report/summary/findings/analysis .md files. Return findings directly as your final assistant message — the parent agent reads your text output, not files you create. (Files written as input to another tool are fine; this note is about report files.)",
].join("\n");

function shellName(): string {
  const shell = process.env.SHELL || "unknown";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("bash")) return "bash";
  return shell;
}

function scratchpadSection(dir: string): string {
  return `# Scratchpad Directory

IMPORTANT: Always use this scratchpad directory for temporary files instead of \`/tmp\` or other system temp directories:
\`${dir}\`

Use this directory for ALL temporary file needs:
- Storing intermediate results or data during multi-step tasks
- Writing temporary scripts or configuration files
- Saving outputs that don't belong in the user's project
- Creating working files during analysis or processing
- Any file that would otherwise go to \`/tmp\`

Only use \`/tmp\` if the user explicitly requests it.

The scratchpad directory is session-specific, isolated from the user's project, and can generally be used without permission prompts.`;
}

/**
 * Runtime environment tail appended to a subagent's folded system block —
 * working directory, platform facts, active model, knowledge cutoff, and the
 * scratchpad directory. Mirrors the main agent's environment awareness.
 */
export function buildSubagentEnvTail(ctx: RequestContext): string {
  const cwd = ctx.cwd;
  const isGitRepo = existsSync(join(cwd, ".git"));
  const model = findModel(ctx.model, ctx.provider);
  const modelLine = model
    ? `You are powered by the model named ${model.displayName}. The exact model ID is ${ctx.model}.`
    : `You are powered by the model ${ctx.model}.`;
  const cutoff = knowledgeCutoffFor(ctx.model);
  const scratchpad = scratchpadDirFor(cwd, ctx.sessionId);

  const lines = [
    "Here is useful information about the environment you are running in:",
    "<env>",
    `Working directory: ${cwd}`,
    `Is directory a git repo: ${isGitRepo ? "Yes" : "No"}`,
    `Platform: ${osPlatform()}`,
    `Shell: ${shellName()}`,
    `OS Version: ${osType()} ${osRelease()}`,
    "</env>",
    modelLine,
    "",
    ...(cutoff ? [`Assistant knowledge cutoff is ${cutoff}.`, ""] : []),
    scratchpadSection(scratchpad),
  ];
  return lines.join("\n");
}
