import type { ToolSchema } from "@/engine/tools/contract.ts";
import type { DeferredOverrides } from "@/engine/tools/deferred-overrides.ts";
import { baseSchemas, deferredSchemas, schemaFor } from "@/engine/tools/index.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import * as registry from "./registry.ts";

const TOOL_SEARCH_TOOL_NAME = "ToolSearch";

export function isDeferredToolName(name: string): boolean {
  return deferredSchemas().some((schema) => schema.name === name);
}

// Announcements are keyed by the announcing agent (main session = the
// undefined scope). A ToolSearch load only widens the loader's OWN declared
// set — another agent's announcement never grants schema knowledge (or
// dispatch rights) to a context that never saw the search result.
const MAIN_ANNOUNCE_SCOPE = "__main__";
const announcedDeferredToolsByScope = new Map<string, Set<string>>();

export type AnnounceScope = string | undefined;

function announceSetFor(scope: AnnounceScope): Set<string> {
  const key = scope ?? MAIN_ANNOUNCE_SCOPE;
  let set = announcedDeferredToolsByScope.get(key);
  if (!set) {
    set = new Set();
    announcedDeferredToolsByScope.set(key, set);
  }
  return set;
}

export function announceDeferredTool(name: string, scope?: AnnounceScope): void {
  if (isDeferredToolName(name) || isMcpToolName(name)) announceSetFor(scope).add(name);
}

export function forceAnnounceDeferredTool(name: string, scope?: AnnounceScope): void {
  announceSetFor(scope).add(name);
}

export function clearDeferredAnnouncements(): void {
  announcedDeferredToolsByScope.clear();
}

/** Drop MCP tools that disappeared from the active runtime after a refresh. */
export function pruneAnnouncedMcpTools(activeNames: ReadonlySet<string>): void {
  for (const announced of announcedDeferredToolsByScope.values()) {
    for (const name of announced) {
      if (isMcpToolName(name) && !activeNames.has(name)) announced.delete(name);
    }
  }
}

// Agent teardown: drop the ephemeral per-agent set so finished fork ids do
// not accumulate. The main scope lives for the process.
export function clearDeferredAnnouncementsForScope(scope: string): void {
  announcedDeferredToolsByScope.delete(scope);
}

export function activeDeferredToolNames(scope?: AnnounceScope): string[] {
  return [...(announcedDeferredToolsByScope.get(scope ?? MAIN_ANNOUNCE_SCOPE) ?? [])];
}

export function schemaNotSentHint(name: string, scope?: AnnounceScope): string | null {
  if (!isDeferredToolName(name)) return null;
  if (announcedDeferredToolsByScope.get(scope ?? MAIN_ANNOUNCE_SCOPE)?.has(name)) return null;
  if (!registry.get(TOOL_SEARCH_TOOL_NAME)) return null;
  return (
    `\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. ` +
    `Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ` +
    `Load the tool first: call ${TOOL_SEARCH_TOOL_NAME} with query "select:${name}", then retry this call.`
  );
}

export function deferredCatalogFor(overrides: DeferredOverrides): string[] {
  return catalogSchemasForOverrides(overrides).map((schema) => schema.name);
}

export function shouldEmitReminder(overrides: DeferredOverrides): boolean {
  return overrides.emitDeferredReminder;
}

export function catalogSchemasForOverrides(
  overrides: DeferredOverrides,
  implementedNames?: ReadonlySet<string>,
): ToolSchema[] {
  return deferredSchemas().filter(
    (schema) =>
      overridesAllowTool(overrides, schema.name) && isImplemented(schema, implementedNames),
  );
}

export function declaredSchemasForOverrides(
  overrides: DeferredOverrides,
  implementedNames: ReadonlySet<string>,
  scope?: AnnounceScope,
): ToolSchema[] {
  const out: ToolSchema[] = baseSchemas.filter(
    (schema) =>
      overridesAllowTool(overrides, schema.name) && isImplemented(schema, implementedNames),
  );
  const extraNames = new Set([...overrides.alwaysDeclare, ...activeDeferredToolNames(scope)]);
  // Background sessions eagerly declare EnterWorktree; ExitWorktree stays
  // deferred.
  if (process.env.CLAUDE_CODE_SESSION_KIND === "bg") extraNames.add("EnterWorktree");
  for (const name of extraNames) {
    const schema = schemaFor(name);
    if (!schema || !isDeferredToolName(name)) continue;
    if (!overridesAllowTool(overrides, name) || !isImplemented(schema, implementedNames)) continue;
    if (!out.some((existing) => existing.name === name)) out.push(schema);
  }
  return out;
}

function overridesAllowTool(overrides: DeferredOverrides, name: string): boolean {
  return !overrides.excludeFromCatalog.includes(name);
}

function isImplemented(schema: ToolSchema, implementedNames: ReadonlySet<string> | undefined) {
  return implementedNames === undefined || implementedNames.has(schema.name);
}
