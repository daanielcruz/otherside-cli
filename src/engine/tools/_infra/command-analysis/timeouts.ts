const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return null;
  return parsed;
}

export function defaultShellTimeoutMs(): number {
  return parsePositiveInt(process.env.BASH_DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
}

export function getMaxBashTimeoutMs(): number {
  const override = parsePositiveInt(process.env.BASH_MAX_TIMEOUT_MS);
  if (override !== null) return Math.max(override, defaultShellTimeoutMs());
  return Math.max(MAX_TIMEOUT_MS, defaultShellTimeoutMs());
}
