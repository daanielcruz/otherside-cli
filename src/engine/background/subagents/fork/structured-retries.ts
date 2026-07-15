const DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES = 5;

export function maxStructuredOutputRetries(): number {
  const raw = process.env.MAX_STRUCTURED_OUTPUT_RETRIES;
  if (!raw) return DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES;
}
