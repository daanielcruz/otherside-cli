import type { SubagentDef } from "@/engine/agents/registry.ts";
import * as agentRegistry from "@/engine/agents/registry.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { findUniqueModel } from "@/engine/model/catalog.ts";
import type { NamespaceLabel } from "@/engine/tools/registry.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import { loadFlagMcpServers } from "@/kernel/mcp/config.ts";
import { parseWireToolName } from "@/kernel/mcp/index.ts";
import { loadNamespacedMcpRuntime } from "@/kernel/mcp/runtime/manager.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import { isProviderId } from "@/kernel/std/types/provider-ids.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import type { InstalledSessionResources, McpStatus, PrintRuntime } from "./types.ts";

function restoreAgents(snapshot: SubagentDef[]): void {
  agentRegistry.clear();
  for (const def of snapshot) agentRegistry.register(def);
}

/**
 * Build a SubagentDef model map for a print-manifest model string.
 * Accepts:
 * - "inherit" / empty → no pin
 * - "provider/model" (or "provider:model") qualified route → pin only that owner
 * - bare model id with a unique catalog owner → pin only that owner
 * Ambiguous bare models throw rather than fanning out under every provider.
 */
function modelMapForInlineAgent(model: string | undefined): SubagentDef["model"] {
  if (
    model === undefined ||
    model.trim().length === 0 ||
    model.trim().toLowerCase() === "inherit"
  ) {
    return {};
  }
  const raw = model.trim();
  const qualified = parseQualifiedRoute(raw);
  if (qualified !== null) {
    return pinForProvider(qualified.provider, qualified.model);
  }
  const unique = findUniqueModel(raw);
  if (unique !== undefined) {
    return pinForProvider(unique.provider, unique.id);
  }
  throw new Error(
    `model "${raw}" is not a unique catalog id; use "provider/model" (e.g. "anthropic/claude-opus-4-8")`,
  );
}

function parseQualifiedRoute(raw: string): { provider: string; model: string } | null {
  const slash = raw.indexOf("/");
  const colon = raw.indexOf(":");
  const sep =
    slash >= 0 && colon >= 0
      ? Math.min(slash, colon)
      : slash >= 0
        ? slash
        : colon >= 0
          ? colon
          : -1;
  if (sep <= 0 || sep === raw.length - 1) return null;
  const provider = raw.slice(0, sep).trim();
  const model = raw.slice(sep + 1).trim();
  if (!isProviderId(provider) || model.length === 0) return null;
  return { provider, model };
}

function pinForProvider(provider: string, model: string): SubagentDef["model"] {
  const out: SubagentDef["model"] = {};
  if (!isProviderId(provider)) return out;
  const config = getProviderConfig(provider);
  out[provider] = { model };
  if (config?.provider.shortKey) out[config.provider.shortKey] = { model };
  return out;
}

function parseToolsField(raw: unknown): SubagentDef["tools"] {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || !raw.every((tool) => typeof tool === "string")) {
    throw new Error("tools must be an array of strings");
  }
  return { kind: "list", tools: raw };
}

function loadInlineAgents(raw: string | undefined): SubagentDef[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("expected JSON object");
  const defs: SubagentDef[] = [];
  for (const [id, manifest] of Object.entries(parsed)) {
    if (!isRecord(manifest)) throw new Error(`entry "${id}" must be an object`);
    const description = manifest.description;
    const prompt = manifest.prompt;
    if (typeof description !== "string" || description.trim().length === 0) {
      throw new Error(`entry "${id}" is missing description`);
    }
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new Error(`entry "${id}" is missing prompt`);
    }
    if (manifest.model !== undefined && typeof manifest.model !== "string") {
      throw new Error(`entry "${id}" model must be a string`);
    }
    let modelMap: SubagentDef["model"];
    try {
      modelMap = modelMapForInlineAgent(manifest.model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`entry "${id}" ${message}`);
    }
    defs.push({
      id,
      name: id,
      description,
      body: prompt,
      tools: parseToolsField(manifest.tools),
      disallowedTools: null,
      model: modelMap,
      background: false,
      scope: "project",
      mcpServers: null,
      skills: null,
      hooks: null,
    });
  }
  return defs;
}

export async function installPrintSessionResources(
  runtime: PrintRuntime,
): Promise<{ resources: InstalledSessionResources | null; error: string | null }> {
  const cleanup: Array<() => void | Promise<void>> = [];
  const toolNames: string[] = [];
  const mcpStatuses: McpStatus[] = [];
  try {
    const agentSnapshot = agentRegistry.list();
    const inlineAgents = loadInlineAgents(process.env.OTHERSIDE_CLI_AGENTS_JSON);
    if (inlineAgents.length > 0) {
      cleanup.push(() => restoreAgents(agentSnapshot));
      for (const def of inlineAgents) agentRegistry.register(def);
    }

    const servers = loadFlagMcpServers(runtime.cwd);
    const serverNames = Object.keys(servers).sort((a, b) => a.localeCompare(b));
    if (serverNames.length > 0) {
      const namespace = `print:${runtime.sessionId}:${uuidv4()}`;
      const mcpRuntime = await loadNamespacedMcpRuntime({ namespace, servers });
      cleanup.push(() => mcpRuntime.close());
      const previous = new Map<
        string,
        { handler: ReturnType<typeof toolRegistry.get>; namespace: NamespaceLabel | undefined }
      >();
      for (const handler of mcpRuntime.handlers) {
        const name = handler.schema.name;
        previous.set(name, {
          handler: toolRegistry.get(name),
          namespace: toolRegistry.getNamespace(name),
        });
        const parsed = parseWireToolName(name);
        const serverName = parsed?.[0] ?? "session";
        toolRegistry.registerWithNamespace(`mcp:${serverName}`, handler);
        toolNames.push(name);
      }
      cleanup.push(() => {
        for (const name of toolNames) {
          toolRegistry.unregister(name);
          const saved = previous.get(name);
          if (!saved?.handler) continue;
          if (saved.namespace) toolRegistry.registerWithNamespace(saved.namespace, saved.handler);
          else toolRegistry.register(saved.handler);
        }
      });
      const failed = new Map(mcpRuntime.failures.map((failure) => [failure.server, failure.error]));
      for (const name of serverNames) {
        mcpStatuses.push({ name, status: failed.has(name) ? "failed" : "connected" });
      }
    }
    return {
      resources: {
        toolNames,
        mcpStatuses,
        agentNames: agentRegistry.list().map((def) => def.name),
        close: async () => {
          for (const fn of cleanup.reverse()) await fn();
        },
      },
      error: null,
    };
  } catch (error) {
    for (const fn of cleanup.reverse()) await fn();
    return {
      resources: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
