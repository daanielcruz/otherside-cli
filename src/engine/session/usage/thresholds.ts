// Single source of truth for quota utilization bands. Every consumer — warning
// text, routing block gate, /usage bar color, raw-window exhaustion — derives
// its cutoffs here so a threshold change never drifts across surfaces.

/** At/above this utilization percent a provider is "warned" (amber). */
export const QUOTA_WARN_PCT = 70;
/**
 * At/above this utilization percent a provider is "blocked" (red / non-routeable).
 * 100 means real exhaustion only: nothing blocks predictively below a fully spent
 * window. Gates must compare the raw (untruncated) percentage, and an explicit
 * provider signal (e.g. Codex `rate_limit_reached_type`) always wins over this
 * derived cutoff — see applyQuotaWarning.
 */
export const QUOTA_BLOCK_PCT = 100;

/** Ratio (0-1) forms for callers that work in fractions rather than percents. */
export const QUOTA_WARN_RATIO = QUOTA_WARN_PCT / 100;
export const QUOTA_BLOCK_RATIO = QUOTA_BLOCK_PCT / 100;
