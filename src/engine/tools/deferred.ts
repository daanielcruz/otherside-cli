import type { ToolSchema } from "@/engine/tools/contract.ts";
import type { DeferredOverrides } from "@/engine/tools/deferred-overrides.ts";
import { baseSchemas, deferredSchemas, schemaFor } from "@/engine/tools/index.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import * as registry from "./registry.ts";

const TOOL_SEARCH_TOOL_NAME = "ToolSearch";

export function isDeferredToolName(name: string): boolean {
  return deferredSchemas().some((schema) => schema.name === name);
}

const announcedDeferredTools = new Set<string>();

export function announceDeferredTool(name: string): void {
  if (isDeferredToolName(name) || isMcpToolName(name)) announcedDeferredTools.add(name);
}

export function forceAnnounceDeferredTool(name: string): void {
  announcedDeferredTools.add(name);
}

export function clearDeferredAnnouncements(): void {
  announcedDeferredTools.clear();
}

export function activeDeferredToolNames(): string[] {
  return [...announcedDeferredTools];
}

export function schemaNotSentHint(name: string): string | null {
  if (!isDeferredToolName(name)) return null;
  if (announcedDeferredTools.has(name)) return null;
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
): ToolSchema[] {
  const out: ToolSchema[] = baseSchemas.filter(
    (schema) =>
      overridesAllowTool(overrides, schema.name) && isImplemented(schema, implementedNames),
  );
  const extraNames = new Set([...overrides.alwaysDeclare, ...announcedDeferredTools]);
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
