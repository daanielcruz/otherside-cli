import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SubagentDef } from "@/engine/agents/registry.ts";
import * as agentRegistry from "@/engine/agents/registry.ts";
import { listProviderConfigs } from "@/engine/contract/registry.ts";
import type { NamespaceLabel } from "@/engine/tools/registry.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import { parseServer } from "@/kernel/mcp/config.ts";
import type { McpServerConfig } from "@/kernel/mcp/index.ts";
import { parseWireToolName } from "@/kernel/mcp/index.ts";
import { loadNamespacedMcpRuntime } from "@/kernel/mcp/runtime/manager.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import { readStringArrayEnv } from "./flags.ts";
import type { InstalledSessionResources, McpStatus, PrintRuntime } from "./types.ts";

function loadMcpConfigEntry(raw: string, cwd: string): Record<string, McpServerConfig> {
  const trimmed = raw.trim();
  const text = trimmed.startsWith("{") ? raw : readFileSync(resolve(cwd, trimmed), "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new Error("expected object with mcpServers object");
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    const config = parseServer(name, server);
    if (config === null) throw new Error(`invalid server "${name}"`);
    servers[name] = config;
  }
  return servers;
}

function restoreAgents(snapshot: SubagentDef[]): void {
  agentRegistry.clear();
  for (const def of snapshot) agentRegistry.register(def);
}

function modelMapForInlineAgent(model: string | undefined): SubagentDef["model"] {
  if (
    model === undefined ||
    model.trim().length === 0 ||
    model.trim().toLowerCase() === "inherit"
  ) {
    return {};
  }
  const out: SubagentDef["model"] = {};
  for (const config of listProviderConfigs()) {
    out[config.provider.shortKey] = { model: model.trim() };
    out[config.provider.id] = { model: model.trim() };
  }
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
    defs.push({
      id,
      name: id,
      description,
      body: prompt,
      tools: parseToolsField(manifest.tools),
      disallowedTools: null,
      model: modelMapForInlineAgent(manifest.model),
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

    const servers: Record<string, McpServerConfig> = {};
    for (const entry of readStringArrayEnv("OTHERSIDE_CLI_MCP_CONFIGS")) {
      Object.assign(servers, loadMcpConfigEntry(entry, runtime.cwd));
    }
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
