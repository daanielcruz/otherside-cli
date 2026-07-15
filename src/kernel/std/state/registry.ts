export interface RegistryOptions<T, _N extends string = string> {
  keyOf: (item: T) => string;
  supportsAlias?: "external" | "inline";
  supportsNamespace?: boolean;
  aliasOf?: (item: T) => readonly string[];
}

export interface Registry<T, N extends string = string> {
  register(item: T): void;
  registerWithNamespace(namespace: N, item: T): void;
  registerAlias(alias: string, canonical: string): void;
  unregister(name: string): void;
  getNamespace(name: string): N | undefined;
  listByNamespace(namespace: N): T[];
  get(name: string): T | undefined;
  aliasNamesFor(canonical: string): string[];
  list(): T[];
  clear(): void;
}

export function createRegistry<T, N extends string = string>(
  options: RegistryOptions<T, N>,
): Registry<T, N> {
  const { keyOf, supportsAlias, supportsNamespace, aliasOf } = options;

  if (supportsAlias === "inline" && !aliasOf) {
    throw new Error("createRegistry: aliasOf is required when supportsAlias is 'inline'");
  }

  const items = new Map<string, T>();
  const aliases = supportsAlias === "external" ? new Map<string, string>() : null;
  const namespaces = supportsNamespace ? new Map<string, N>() : null;

  function register(item: T): void {
    items.set(keyOf(item), item);
  }

  function registerWithNamespace(namespace: N, item: T): void {
    const key = keyOf(item);
    items.set(key, item);
    namespaces?.set(key, namespace);
  }

  function registerAlias(alias: string, canonical: string): void {
    aliases?.set(alias, canonical);
  }

  function unregister(name: string): void {
    items.delete(name);
    namespaces?.delete(name);
  }

  function getNamespace(name: string): N | undefined {
    return namespaces?.get(name);
  }

  function listByNamespace(namespace: N): T[] {
    if (!namespaces) return [];
    const result: T[] = [];
    for (const [key, label] of namespaces) {
      if (label === namespace) {
        const item = items.get(key);
        if (item !== undefined) result.push(item);
      }
    }
    return result;
  }

  function get(name: string): T | undefined {
    const direct = items.get(name);
    if (direct !== undefined) return direct;

    if (supportsAlias === "external" && aliases) {
      const canonical = aliases.get(name);
      if (canonical !== undefined) return items.get(canonical);
    }

    if (supportsAlias === "inline" && aliasOf) {
      for (const item of items.values()) {
        if (aliasOf(item).includes(name)) return item;
      }
    }

    return undefined;
  }

  function aliasNamesFor(canonical: string): string[] {
    if (!supportsAlias) return [];

    if (supportsAlias === "external" && aliases) {
      const result: string[] = [];
      for (const [alias, target] of aliases) {
        if (target === canonical) result.push(alias);
      }
      return result;
    }

    if (supportsAlias === "inline" && aliasOf) {
      const item = items.get(canonical);
      if (!item) return [];
      return [...aliasOf(item)];
    }

    return [];
  }

  function list(): T[] {
    return [...items.values()];
  }

  function clear(): void {
    items.clear();
    aliases?.clear();
    namespaces?.clear();
  }

  return {
    register,
    registerWithNamespace,
    registerAlias,
    unregister,
    getNamespace,
    listByNamespace,
    get,
    aliasNamesFor,
    list,
    clear,
  };
}
