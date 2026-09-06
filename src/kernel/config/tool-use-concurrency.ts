const DEFAULT_MAX_TOOL_USE_CONCURRENCY = 10;

export function maxConcurrentToolUses(): number {
  const raw = process.env.OTHERSIDE_MAX_TOOL_USE_CONCURRENCY;
  if (raw === undefined) return DEFAULT_MAX_TOOL_USE_CONCURRENCY;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_TOOL_USE_CONCURRENCY;
  return Math.max(1, parsed);
}
