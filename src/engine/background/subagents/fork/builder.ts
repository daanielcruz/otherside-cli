import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";

export const FORK_BOILERPLATE_TAG = "fork-boilerplate";
export const FORK_DIRECTIVE_PREFIX = "Your directive: ";
export const FORK_PLACEHOLDER_RESULT = "Fork started — processing in background";

export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
You are a worker fork. The transcript above is the parent's history — inherited reference, not your situation. You are NOT a continuation of that agent. Execute ONE directive, then stop.

Hard rules:
- Execute directly by default. The "default to forking" guidance is for the parent; spawn a nested agent only when your directive genuinely needs parallel or isolated work.
- One shot: report once and stop. No follow-up questions, no proposed next steps, no waiting for the user.

Guidelines (your directive may override any of these):
- Stay in scope. Other forks may be handling adjacent work; if you spot something outside your directive, note it in a sentence and move on.
- Open with one line restating your task, so the parent can spot scope drift at a glance.
- Be concise — as short as the answer allows, no shorter. Plain text, no preamble, no meta-commentary.
- If you committed changes, list the paths and commit hashes in your report.
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`;
}

export function buildWorktreeNotice(parentCwd: string, worktreeCwd: string): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}. You are operating in an isolated git worktree at ${worktreeCwd} — same repository, same relative file structure, separate working copy. Paths in the inherited context refer to the parent's working directory; translate them to your worktree root. Re-read files before editing if the parent may have modified them since they appear in the context. Your changes stay in this worktree and will not affect the parent's files.`;
}

interface ToolUseRef {
  id: string;
}

function collectToolUseIds(assistant: Message): ToolUseRef[] {
  if (!Array.isArray(assistant.content)) return [];
  const refs: ToolUseRef[] = [];
  for (const block of assistant.content) {
    if (block.type === "tool_use" && typeof block.id === "string" && block.id.length > 0) {
      refs.push({ id: block.id });
    }
  }
  return refs;
}

export function danglingToolResultPlaceholders(parentMessages: readonly Message[]): ContentBlock[] {
  const last = parentMessages.at(-1);
  if (!last || last.role !== "assistant") return [];
  return collectToolUseIds(last).map((tu) => ({
    type: "tool_result",
    tool_use_id: tu.id,
    content: FORK_PLACEHOLDER_RESULT,
  }));
}

export function assembleForkMessages(
  directive: string,
  parentMessages: readonly Message[],
): Message[] {
  const childText = buildChildMessage(directive);
  const placeholderResults = danglingToolResultPlaceholders(parentMessages);
  return [
    ...parentMessages,
    {
      role: "user",
      content: [...placeholderResults, { type: "text", text: childText }],
    },
  ];
}
