import type { UsageSnapshot } from "./token-count.ts";

let lastUsage: UsageSnapshot | null = null;
let fromServer = false;

export function setLastUsage(usage: UsageSnapshot | null): void {
  lastUsage = usage;
  fromServer = usage !== null;
}

export function setEstimatedUsage(usage: UsageSnapshot): void {
  lastUsage = usage;
  fromServer = false;
}

export function getLastUsage(): UsageSnapshot | null {
  return lastUsage;
}

export function hasServerUsage(): boolean {
  return fromServer;
}

export function clearLastUsage(): void {
  lastUsage = null;
  fromServer = false;
}
