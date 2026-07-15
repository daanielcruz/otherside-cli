import type { McpInstructionBlock } from "@/harness/composer/injections.ts";

export function renderMcpInstructions(blocks: readonly McpInstructionBlock[]): string | null {
  if (blocks.length === 0) return null;
  const body = blocks.map((block) => `## ${block.server}\n${block.text}`).join("\n\n");
  return `<system-reminder>
# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

${body}
</system-reminder>`;
}
