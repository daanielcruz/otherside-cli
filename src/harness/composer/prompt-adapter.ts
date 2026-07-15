import type { LayerDescriptor } from "@/harness/composer/manifest.ts";

export interface ProviderPromptAdapter {
  exclude?: string[];
  prepend?: LayerDescriptor[];
  append?: LayerDescriptor[];
  excludeBaseTools?: string[];
}

export function applyAdapter(
  stack: readonly LayerDescriptor[],
  adapter: ProviderPromptAdapter | null | undefined,
): LayerDescriptor[] {
  if (!adapter) return [...stack];
  const skip = new Set(adapter.exclude ?? []);
  const filtered = stack.filter((l) => !skip.has(l.name));
  return [...(adapter.prepend ?? []), ...filtered, ...(adapter.append ?? [])];
}

export function adapterExcludedBaseTools(
  adapter: ProviderPromptAdapter | null | undefined,
): ReadonlySet<string> {
  if (!adapter?.excludeBaseTools) return new Set();
  return new Set(adapter.excludeBaseTools);
}
