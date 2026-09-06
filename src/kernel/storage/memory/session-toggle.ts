import { loadConfigSync } from "@/kernel/config/config.ts";
import { isEnvTruthy } from "@/kernel/std/proc/env.ts";

function readBaseAutoMemoryEnabled(): boolean {
  const disableEnv = process.env.OTHERSIDE_DISABLE_AUTO_MEMORY;
  if (isEnvTruthy(disableEnv)) return false;
  if (loadConfigSync().autoMemoryEnabled === false) return false;
  return true;
}

let sessionOverride: boolean | null = null;

export function isSessionMemoryEnabled(): boolean {
  if (sessionOverride !== null) return sessionOverride;
  return readBaseAutoMemoryEnabled();
}

export function setSessionMemoryEnabled(enabled: boolean | null): void {
  sessionOverride = enabled;
}

export function _resetAutoMemorySessionForTesting(): void {
  sessionOverride = null;
}
