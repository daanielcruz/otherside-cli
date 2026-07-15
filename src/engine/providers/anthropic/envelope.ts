export const ANTHROPIC_ENVELOPE_DEFAULTS = {
  max_tokens: 64000,
  thinking: {
    type: "adaptive",
    display: "summarized",
  },
  context_management: {
    edits: [
      {
        type: "clear_thinking_20251015",
        keep: "all",
      },
    ],
  },
  output_config: {
    effort: "xhigh",
  },
  stream: true,
} as const;

export function anthropicEnvelopeDefaults(): Record<string, unknown> {
  return structuredClone(ANTHROPIC_ENVELOPE_DEFAULTS) as Record<string, unknown>;
}

export function maxOutputTokensForModel(model: string): number {
  const m = model.toLowerCase();
  if (
    m.includes("fable-5") ||
    m.includes("opus-4-8") ||
    m.includes("opus-4-7") ||
    m.includes("opus-4-6") ||
    m.includes("sonnet-5")
  )
    return 64_000;
  if (m.includes("sonnet-4-6")) return 32_000;
  if (m.includes("opus-4-5") || m.includes("sonnet-4") || m.includes("haiku-4")) return 32_000;
  if (m.includes("opus-4-1") || m.includes("opus-4")) return 32_000;
  if (m.includes("3-7-sonnet")) return 32_000;
  return 32_000;
}
