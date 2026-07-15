import { getAgentContext } from "@/engine/agents/agent-context.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import {
  announceDeferredTool,
  catalogSchemasForOverrides,
  forceAnnounceDeferredTool,
  isDeferredToolName,
} from "@/engine/tools/deferred.ts";
import { isForkDisallowedTool } from "@/engine/tools/fork-disallowed.ts";
import { baseSchemas } from "@/engine/tools/index.ts";
import * as registry from "@/engine/tools/registry.ts";
import ToolSearchSchema from "@/harness/tools/ToolSearch/tool.json" with { type: "json" };
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import { hasWholeToolDenyRule } from "@/kernel/permissions/index.ts";
import { loadRulesSync } from "@/kernel/permissions/persist.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const DEFAULT_MAX_RESULTS = 5;
// Design-canvas tools that live OUTSIDE the base catalog: ToolSearch surfaces
// them only when the design surface has injected a scoped handler
// (ctx.scopedToolHandlers). scopeFilter hides them from a normal session even if
// something registers a handler, so they never leak into the deferred roster.
const DESIGN_SCOPED_TOOL_NAMES = new Set(["AssetNotify", "CanvasOp"]);

interface ToolSearchInput {
  query?: unknown;
  max_results?: unknown;
}

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

// Multi-term keyword ranking (the documented behaviour): split the query into
// terms; a `+term` REQUIRES `term` in the tool name; every tool is scored by how
// many terms it matches (name hit weighs more than description) and the best are
// returned. A literal-substring match of the whole query missed multi-word
// queries like "notebook jupyter".
export function keywordSearch(pool: CatalogEntry[], query: string): CatalogEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const required = terms
    .filter((t) => t.startsWith("+"))
    .map((t) => t.slice(1))
    .filter(Boolean);
  const optional = terms.filter((t) => !t.startsWith("+"));
  const scored: Array<{ entry: CatalogEntry; score: number }> = [];
  for (const entry of pool) {
    const name = entry.name.toLowerCase();
    const description = entry.description.toLowerCase();
    if (required.some((t) => !name.includes(t))) continue;
    let score = required.length;
    for (const t of optional) {
      if (name.includes(t)) score += 2;
      else if (description.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
}

interface CatalogEntry {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function catalog(ctx: RequestContext): CatalogEntry[] {
  const permissionRules = loadRulesSync(ctx.cwd);
  const overrides = getProviderConfig(ctx.provider)?.deferredOverrides ?? {
    excludeFromCatalog: [],
    alwaysDeclare: [],
    emitDeferredReminder: true,
  };
  const implemented = new Set(registry.list().map((handler) => handler.schema.name));
  for (const name of ctx.scopedToolHandlers?.keys() ?? []) implemented.add(name);
  const forkAllowSet = ctx.forkAllowSet;
  const scopeFilter = (name: string): boolean => {
    if (DESIGN_SCOPED_TOOL_NAMES.has(name) && !ctx.scopedToolHandlers?.has(name)) {
      return false;
    }
    if (forkAllowSet === undefined) return true;
    if (isForkDisallowedTool(name, getAgentContext()?.permissionModeOverride)) return false;
    if (forkAllowSet === null) return true;
    return forkAllowSet.has(name) || (ctx.forkDeferredAllow?.has(name) ?? false);
  };
  const schemas = [
    ...baseSchemas.filter((schema) => implemented.has(schema.name) && scopeFilter(schema.name)),
    ...catalogSchemasForOverrides(overrides, implemented).filter((schema) =>
      scopeFilter(schema.name),
    ),
    ...registry
      .list()
      .map((handler) => handler.schema)
      .filter(
        (schema) =>
          isMcpToolName(schema.name) &&
          scopeFilter(schema.name) &&
          !hasWholeToolDenyRule(permissionRules, schema.name),
      ),
  ];
  // Fork-scoped tools (e.g. the design toolset) are declared directly, but a
  // model probing ToolSearch for them must still find them — an empty match
  // reads as "tool doesn't exist" and sends the model into a search loop.
  const indexed = new Set(schemas.map((schema) => schema.name));
  for (const handler of ctx.scopedToolHandlers?.values() ?? []) {
    const schema = handler.schema;
    if (
      !indexed.has(schema.name) &&
      scopeFilter(schema.name) &&
      (!isMcpToolName(schema.name) || !hasWholeToolDenyRule(permissionRules, schema.name))
    )
      schemas.push(schema);
  }
  return schemas.map((schema) => ({
    name: schema.name,
    description: schema.description,
    input_schema: schema.inputSchema,
  }));
}

function deferredOnly(entries: CatalogEntry[], alsoKeep?: ReadonlySet<string>): CatalogEntry[] {
  return entries.filter(
    (e) => isDeferredToolName(e.name) || isMcpToolName(e.name) || (alsoKeep?.has(e.name) ?? false),
  );
}

export const ToolSearch: ToolHandler = {
  schema: {
    name: ToolSearchSchema.name,
    description: ToolSearchSchema.description,
    inputSchema: ToolSearchSchema.inputSchema,
  },
  isConcurrencySafe: true,
  render: {
    isTransparent: () => true,
  },
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as ToolSearchInput;
    const query = typeof args.query === "string" ? args.query : null;
    if (query == null) return err(call.id, "query is required");

    const maxResults =
      typeof args.max_results === "number" &&
      Number.isFinite(args.max_results) &&
      args.max_results > 0
        ? Math.floor(args.max_results)
        : DEFAULT_MAX_RESULTS;

    const all = catalog(ctx);
    const scopedNames: ReadonlySet<string> = new Set(ctx.scopedToolHandlers?.keys() ?? []);
    let matches: CatalogEntry[];

    const selectPrefix = "select:";
    if (query.toLowerCase().startsWith(selectPrefix)) {
      const wanted = query
        .slice(selectPrefix.length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      matches = all.filter((s) => wanted.includes(s.name));
    } else if (query.trim() === "") {
      matches = deferredOnly(all, scopedNames);
    } else {
      matches = keywordSearch(deferredOnly(all, scopedNames), query);
    }

    const tools = matches.slice(0, maxResults).map((s) => ({
      name: s.name,
      description: s.description,
      input_schema: s.input_schema,
    }));
    for (const tool of tools) {
      // Scoped tools are already declared on the request — announcing them as
      // deferred would double-declare on the next round.
      if (scopedNames.has(tool.name)) continue;
      if (ctx.forkDeferredAllow?.has(tool.name)) {
        forceAnnounceDeferredTool(tool.name);
      } else {
        announceDeferredTool(tool.name);
      }
    }

    return {
      tool_use_id: call.id,
      content: JSON.stringify({
        query,
        max_results: maxResults,
        tools,
      }),
    };
  },
};
