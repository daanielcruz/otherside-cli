import { createHash } from "node:crypto";
import type { OrchestrationMode } from "@/kernel/std/types/orchestration-mode.ts";
import { WORKFLOW_AGENT_CACHE_KEYS } from "./agent-options.ts";

const AGENT_CACHE_KEY_VERSION = "v5";
const CACHE_KEY_PARTICIPATING_KEYS = WORKFLOW_AGENT_CACHE_KEYS;

function canonicalizeValue(value: unknown): unknown {
  if (typeof value === "function") return undefined;
  if (Array.isArray(value)) {
    const length = Number.isSafeInteger(value.length) ? value.length : 0;
    const result: unknown[] = [];
    for (let i = 0; i < length; i++) {
      result.push(canonicalizeValue(value[i]));
    }
    return result;
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value)
      .filter((k) => k !== "__proto__")
      .sort();
    for (const key of keys) {
      const child = canonicalizeValue(Object(value)[key]);
      if (child !== undefined) sorted[key] = child;
    }
    return sorted;
  }
  return value;
}

export function normalizeAgentCacheKeyOptions(options: unknown): string {
  if (!options) return "{}";
  if (typeof options !== "object" || Array.isArray(options)) return "{}";
  const picked: Record<string, unknown> = {};
  for (const key of CACHE_KEY_PARTICIPATING_KEYS) {
    const val = Object(options)[key];
    if (val === undefined || typeof val === "function") continue;
    const canon = canonicalizeValue(val);
    if (canon !== undefined) picked[key] = canon;
  }
  return JSON.stringify(canonicalizeValue(picked));
}

function computeAgentCacheDigest(
  prompt: string,
  options: unknown,
  identity: string,
  orchestrationMode: OrchestrationMode,
): string {
  return createHash("sha256")
    .update(identity)
    .update("\0")
    .update(orchestrationMode)
    .update("\0")
    .update(prompt)
    .update("\0")
    .update(normalizeAgentCacheKeyOptions(options))
    .digest("hex");
}

export function deriveAgentCacheKey(
  prompt: string,
  options: unknown,
  structuralPath: string,
  prevKey: string,
  orchestrationMode: OrchestrationMode = "disabled",
): string {
  const identity = `${structuralPath}\0${prevKey}`;
  return `${AGENT_CACHE_KEY_VERSION}:${computeAgentCacheDigest(prompt, options, identity, orchestrationMode)}`;
}
