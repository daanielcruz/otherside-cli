import { allSchemas } from "@/engine/tools/index.ts";
import { createRegistry } from "@/kernel/std/state/registry.ts";
import type { ToolHandler } from "./contract.ts";

export type NamespaceLabel = "builtin" | `mcp:${string}` | `skill:${string}`;

const instance = createRegistry<ToolHandler, NamespaceLabel>({
  keyOf: (handler) => handler.schema.name,
  supportsAlias: "external",
  supportsNamespace: true,
});

export function register(handler: ToolHandler): void {
  instance.register(handler);
}

export function registerWithNamespace(namespace: NamespaceLabel, handler: ToolHandler): void {
  instance.registerWithNamespace(namespace, handler);
}

export function registerAlias(alias: string, canonical: string): void {
  instance.registerAlias(alias, canonical);
}

export function unregister(name: string): void {
  instance.unregister(name);
}

export function getNamespace(name: string): NamespaceLabel | undefined {
  return instance.getNamespace(name);
}

export function listByNamespace(namespace: NamespaceLabel): ToolHandler[] {
  return instance.listByNamespace(namespace);
}

export function get(name: string): ToolHandler | undefined {
  return instance.get(name);
}

export function aliasNamesFor(canonical: string): string[] {
  return instance.aliasNamesFor(canonical);
}

export function list(): ToolHandler[] {
  return instance.list();
}

export function assertBuiltinsHaveSchemas(
  handlers: readonly ToolHandler[],
  nonWireHandlerNames: readonly string[] = [],
): void {
  const schemaNames = new Set(allSchemas.map((s) => s.name));
  const nonWire = new Set(nonWireHandlerNames);
  const missing: string[] = [];
  for (const handler of handlers) {
    if (!schemaNames.has(handler.schema.name) && !nonWire.has(handler.schema.name)) {
      missing.push(handler.schema.name);
    }
  }
  if (missing.length > 0) {
    throw new Error(`builtin tools without registered schema: ${missing.join(", ")}`);
  }
}
