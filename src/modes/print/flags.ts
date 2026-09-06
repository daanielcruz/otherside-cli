import { resolve } from "node:path";
import type { Provider } from "@/engine/contract/types.ts";
import * as providers from "@/engine/providers/registry.ts";
import type { Agent } from "@/engine/queue/index.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import { permissionDirectoryGlob, serializeRuleValue } from "@/kernel/permissions/types.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import { isProviderId, type ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import type { PrintRuntime } from "./types.ts";

function readCliAddDirs(): string[] {
  const raw = process.env.OTHERSIDE_CLI_ADD_DIRS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((dir): dir is string => typeof dir === "string")
      : [];
  } catch {
    return [];
  }
}

export function readStringArrayEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function readJsonSchemaEnv():
  | { schema: Record<string, unknown> | null; error: null }
  | { schema: null; error: string } {
  const raw = process.env.OTHERSIDE_CLI_JSON_SCHEMA;
  if (!raw) return { schema: null, error: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { schema: null, error: "invalid --json-schema: expected JSON object" };
    }
    return { schema: parsed, error: null };
  } catch (error) {
    return {
      schema: null,
      error: `invalid --json-schema JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function numericCliEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function printProviderId(agent: Agent): ProviderId | null {
  const state = (
    agent as Agent & { deps?: { broker?: { read: () => { provider?: unknown } } } }
  ).deps?.broker?.read();
  return isProviderId(state?.provider) ? state.provider : null;
}

function applySystemPromptFlags(harness: ComposedHarness): ComposedHarness {
  const replacement = process.env.OTHERSIDE_CLI_SYSTEM_PROMPT;
  const append = process.env.OTHERSIDE_CLI_APPEND_SYSTEM_PROMPT;
  if (replacement === undefined && append === undefined) return harness;
  if (replacement !== undefined) {
    const appended = append === undefined ? replacement : `${replacement}\n\n${append}`;
    return {
      layers: [{ name: "system-prompt", body: appended }],
      combined: appended,
      systemBlocks: [{ text: appended, phase: "dynamic", bundleKey: "system-prompt" }],
      userPrepend: [],
      midSystemPromotion: "off",
    };
  }
  const combined =
    harness.combined.length > 0 ? `${harness.combined}\n\n${append}` : (append ?? "");
  return {
    ...harness,
    layers:
      append === undefined
        ? harness.layers
        : [...harness.layers, { name: "system-prompt", body: append }],
    combined,
    systemBlocks:
      append === undefined
        ? harness.systemBlocks
        : [...harness.systemBlocks, { text: append, phase: "dynamic", bundleKey: "system-prompt" }],
  };
}

export function installSystemPromptProvider(agent: Agent): () => void {
  if (
    process.env.OTHERSIDE_CLI_SYSTEM_PROMPT === undefined &&
    process.env.OTHERSIDE_CLI_APPEND_SYSTEM_PROMPT === undefined
  ) {
    return () => {};
  }
  const providerId = printProviderId(agent);
  if (providerId === null) return () => {};
  const base = providers.get(providerId);
  const wrapped: Provider = {
    ...base,
    composeMessages: (harness, history) =>
      base.composeMessages(applySystemPromptFlags(harness), history),
  };
  providers.register(wrapped);
  return () => providers.register(base);
}

export function applyPrintSessionFlags(agent: Agent, runtime: PrintRuntime): string {
  const requestedSessionId = process.env.OTHERSIDE_CLI_SESSION_ID?.trim();
  const shouldFork =
    !requestedSessionId &&
    process.env.OTHERSIDE_CLI_FORK_SESSION === "1" &&
    process.env.OTHERSIDE_CLI_RESUME_ACTIVE === "1";
  const effectiveSessionId = requestedSessionId || (shouldFork ? uuidv4() : runtime.sessionId);
  if (effectiveSessionId !== runtime.sessionId) {
    const session = (agent as Agent & { deps?: { session?: { id: string } } }).deps?.session;
    if (session) session.id = effectiveSessionId;
  }

  const sessionAllowed = (agent as Agent & { sessionAllowedToolPatterns?: Set<string> })
    .sessionAllowedToolPatterns;
  if (sessionAllowed) {
    for (const dir of readCliAddDirs()) {
      const absolute = resolve(runtime.cwd, dir);
      for (const ruleContent of [absolute, permissionDirectoryGlob(absolute)]) {
        sessionAllowed.add(serializeRuleValue({ toolName: "Read", ruleContent }));
      }
    }
  }
  return effectiveSessionId;
}
