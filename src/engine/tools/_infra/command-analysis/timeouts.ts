import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_BACKGROUND_TIMEOUT_MS = 1_800_000;
const MAX_BACKGROUND_TIMEOUT_MS = 7_200_000;
// A timer delay above a signed 32-bit int fires immediately.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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

export function defaultBackgroundTimeoutMs(): number {
  return Math.max(DEFAULT_BACKGROUND_TIMEOUT_MS, defaultShellTimeoutMs());
}

export function getMaxBackgroundTimeoutMs(): number {
  return Math.min(Math.max(MAX_BACKGROUND_TIMEOUT_MS, getMaxBashTimeoutMs()), MAX_TIMER_DELAY_MS);
}

export function foregroundTimeoutMs(requestedMs: number | null): number {
  return Math.min(requestedMs ?? defaultShellTimeoutMs(), getMaxBashTimeoutMs());
}

// A background shell runs under a time limit only when nobody is at the
// terminal; in an interactive session it runs until it exits or is stopped.
export function backgroundDeadlineApplies(): boolean {
  const runtime = getRuntimeKind();
  return runtime === "print" || runtime === "piped";
}

// How long a background shell may run before it is stopped, or undefined when
// background shells run without a time limit.
export function backgroundTimeoutMs(requestedMs: number | null): number | undefined {
  if (!backgroundDeadlineApplies()) return undefined;
  return Math.min(requestedMs ?? defaultBackgroundTimeoutMs(), getMaxBackgroundTimeoutMs());
}
