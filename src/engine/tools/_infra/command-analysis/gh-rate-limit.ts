const GH_INVOCATION_RE =
  /(?:^|[;&|]|\b(?:then|do)\b)\s*gh\s+(?!auth\b|help\b|version\b|alias\b|completion\b|config\b)/;

const GH_RATE_LIMIT_TEXT_RE =
  /API rate limit (?:already )?exceeded|exceeded a secondary rate limit|\bRATE_LIMITED\b/i;

const RATE_LIMIT_REMINDER_COOLDOWN_MS = 60_000;

const RATE_LIMIT_REMINDER =
  "<system-reminder>GitHub API rate limit exceeded (5,000/hr shared across all tools and agents). Run `gh api rate_limit --jq .resources` and sleep until reset before further gh calls.</system-reminder>";

let nextAllowedAt = 0;

export function buildGhRateLimitReminderIfDue(
  command: string,
  output: string,
  nowMs: number = Date.now(),
): string | null {
  if (!GH_INVOCATION_RE.test(command)) return null;
  if (!GH_RATE_LIMIT_TEXT_RE.test(output)) return null;
  if (nowMs < nextAllowedAt) return null;
  nextAllowedAt = nowMs + RATE_LIMIT_REMINDER_COOLDOWN_MS;
  return RATE_LIMIT_REMINDER;
}

export function _resetGhRateLimitCooldownForTests(): void {
  nextAllowedAt = 0;
}
