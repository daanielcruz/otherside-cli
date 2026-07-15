import type { AgentRowData, LayerContext } from "@/harness/composer/injections.ts";
import type { CategorizedLayer } from "@/harness/composer/types.ts";

function formatAgentRow(row: AgentRowData, lean: boolean): string {
  const blurb = lean ? (row.whenToUseLean ?? row.whenToUse) : row.whenToUse;
  return `- ${row.agentType}: ${blurb} (Tools: ${row.toolsLabel})`;
}

export const agentListingLayer: CategorizedLayer = {
  name: "agent-listing",
  kind: "mid-system",
  render(ctx: LayerContext) {
    const rows = ctx.agentRows ?? [];
    const lines = rows.map((row) => formatAgentRow(row, !!ctx.lean)).join("\n");
    return `<system-reminder>\nAvailable agent types for the Agent tool:\n${lines}\n\nWhen you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.\n</system-reminder>`;
  },
};
