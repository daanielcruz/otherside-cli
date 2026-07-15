import type { CategorizedLayer, LayerContext } from "@/harness/composer/types.ts";

interface GuidanceModelRow {
  id: string;
  display: string;
  onDemand?: boolean;
}

function formatModelLine(model: GuidanceModelRow): string {
  if (model.display === model.id) return `- ${model.id}`;
  return `- ${model.id} (${model.display})`;
}

function providerSection(row: { provider: string; models: readonly GuidanceModelRow[] }): string {
  const defaults = row.models.filter((model) => model.onDemand !== true);
  const onDemand = row.models.filter((model) => model.onDemand === true);
  const lines = [`## ${row.provider}`];
  if (defaults.length > 0) lines.push("### Default", ...defaults.map(formatModelLine));
  if (onDemand.length > 0) lines.push("### On-demand", ...onDemand.map(formatModelLine));
  return lines.join("\n");
}

function buildAvailableModelsGuidance(
  rows: readonly { provider: string; models: readonly GuidanceModelRow[] }[],
): string {
  const header = [
    "# Available models",
    "Models available for delegated agents (Agent/Workflow `provider` + `model`). Within each provider, models are listed strongest first — but strongest is not always the best fit: match the model to the task shape (fast iterators often beat heavier models on mechanical or iterative work). Providers or models without remaining quota are omitted.",
    "Default models form the normal routing pool. On-demand models are used only when explicitly requested or when a task specifically calls for their capability.",
  ].join("\n");

  return [header, ...rows.map(providerSection)].join("\n\n");
}

export const availableModelsLayer: CategorizedLayer = {
  name: "available-models",
  kind: "system",
  cache: "1h",
  phase: "dynamic",
  render(ctx: LayerContext) {
    if (!ctx.multiproviderEnabled) return null;
    const rows = ctx.availableModels ?? [];
    if (rows.length === 0) return null;
    return buildAvailableModelsGuidance(rows);
  },
};
