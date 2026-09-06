// Model-fact SoT leaf: each model's training knowledge cutoff. A model fact, so
// it lives in engine/model (not the harness, which only renders it). The engine
// resolves it and injects the string into the harness LayerContext; harness
// imports nothing from here. The future model registry absorbs this table.

const KNOWLEDGE_CUTOFFS: readonly (readonly [prefix: string, cutoff: string])[] = [
  ["claude-fable-5", "January 2026"],
  ["claude-opus-5", "January 2026"],
  ["claude-opus-4-8", "January 2026"],
  ["claude-opus-4-7", "January 2026"],
  ["claude-opus-4-6", "May 2025"],
  ["claude-opus-4-5", "May 2025"],
  ["claude-opus-4-1", "January 2025"],
  ["claude-opus-4-0", "January 2025"],
  ["claude-sonnet-5", "January 2026"],
  ["claude-sonnet-4-6", "August 2025"],
  ["claude-sonnet-4-5", "January 2025"],
  ["claude-sonnet-4-0", "January 2025"],
  ["claude-haiku-4-5", "February 2025"],
  ["gpt-5.6", "December 2025"],
  ["gpt-5.5", "December 2025"],
  ["gpt-5.4", "August 2025"],
  ["gpt-5.3", "August 2025"],
  ["gpt-oss", "June 2024"],
  ["gemini-2.0", "August 2024"],
  ["gemini-2.5", "January 2025"],
  ["gemini-3", "January 2025"],
  ["deepseek-v4", "December 2025"],
  ["glm-5.2", "February 2026"],
  ["glm-5-turbo", "December 2025"],
  ["kimi", "March 2025"],
  ["minimax-m3", "August 2025"],
  ["MiniMax-M2", "August 2025"],
];

export function knowledgeCutoffFor(model: string | undefined): string | null {
  if (!model) return null;
  for (const [prefix, cutoff] of KNOWLEDGE_CUTOFFS) {
    if (model.startsWith(prefix)) return cutoff;
  }
  return null;
}
