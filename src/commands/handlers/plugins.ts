import type { SlashResult } from "@/commands/types.ts";
import {
  changeEnabledWithDependencies,
  registryDependencyPlugins,
  requiredByWarning,
  reverseDependents,
} from "@/engine/plugins/dependencies.ts";
import { installPlugin, removePlugin } from "@/engine/plugins/install.ts";
import {
  findPluginInstallation,
  formatPluginLookupFailure,
  lookupPluginInstallation,
} from "@/engine/plugins/installations.ts";
import { type AddMarketplaceResult, addMarketplace } from "@/engine/plugins/marketplace.ts";
import {
  findMarketplacePlugin,
  installMarketplacePlugin,
  updateMarketplacePlugin,
} from "@/engine/plugins/marketplace-install.ts";
import {
  getKnownMarketplace,
  listAvailableMarketplaces,
  removeKnownMarketplace,
} from "@/engine/plugins/marketplaces-store.ts";
import * as plugins from "@/engine/plugins/registry.ts";

const INSTALL_SCOPES = ["user", "project", "local"] as const;
type InstallScope = (typeof INSTALL_SCOPES)[number];

function requestedScope(parts: readonly string[]): {
  scope?: InstallScope;
  args: string[];
  error?: string;
} {
  const remaining: string[] = [];
  let scope: InstallScope | undefined;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const inline = part.startsWith("--scope=") ? part.slice("--scope=".length) : undefined;
    if (part === "--scope" || inline !== undefined) {
      const raw = inline ?? parts[++index];
      if (!raw || !INSTALL_SCOPES.includes(raw as InstallScope)) {
        return {
          args: [],
          error: `Invalid scope "${raw ?? ""}". Valid scopes: ${INSTALL_SCOPES.join(", ")}`,
        };
      }
      scope = raw as InstallScope;
      continue;
    }
    remaining.push(part);
  }
  return { ...(scope === undefined ? {} : { scope }), args: remaining };
}

function marketplaceUpdateFeedback(result: AddMarketplaceResult): string {
  if (!result.ok) return `Marketplace update failed: ${result.error ?? "unknown error"}`;
  const bumped = result.bumped ?? 0;
  return `Updated marketplace ${result.name}: ${result.count ?? 0} plugins, ${bumped} plugin${bumped === 1 ? "" : "s"} bumped.`;
}

type PluginCommandLookup =
  | { ok: true; pluginId: string }
  | {
      ok: false;
      code: "PLUGIN_NOT_FOUND" | "PLUGIN_AMBIGUOUS";
      target: string;
      candidates: readonly string[];
    };

function resolvePluginCommandTarget(target: string): PluginCommandLookup {
  const active = plugins.resolvePlugin(target);
  if (active.ok) return { ok: true, pluginId: active.pluginId };
  if (active.code === "PLUGIN_AMBIGUOUS") return active;
  const installed = lookupPluginInstallation(target);
  if (installed.ok) return { ok: true, pluginId: installed.pluginId };
  return installed;
}

function resolveUninstallTarget(target: string): PluginCommandLookup {
  const installed = lookupPluginInstallation(target);
  if (installed.ok) return { ok: true, pluginId: installed.pluginId };
  if (installed.code === "PLUGIN_AMBIGUOUS") return installed;
  const active = plugins.resolvePlugin(target);
  return !active.ok && active.code === "PLUGIN_AMBIGUOUS" ? active : installed;
}

function lookupFeedback(result: Extract<PluginCommandLookup, { ok: false }>): string {
  return formatPluginLookupFailure(result);
}

export async function handleMarketplace(args: string): Promise<SlashResult> {
  const parts = args.trim().split(/\s+/);
  const action = parts[0]?.toLowerCase() || "list";
  const target = parts.slice(1).join(" ").trim();

  if (action === "list") {
    const entries = listAvailableMarketplaces();
    return {
      kind: "instant",
      feedback:
        entries.length === 0
          ? "No marketplaces configured."
          : ["Configured marketplaces:", ...entries.map((entry) => `• ${entry.name}`)].join("\n"),
    };
  }
  if (action === "add") {
    if (!target) return { kind: "instant", feedback: "Usage: /marketplace add <source>" };
    const result = await addMarketplace(target);
    return {
      kind: "instant",
      feedback: result.ok
        ? `Successfully added marketplace: ${result.name}`
        : `Failed to add marketplace: ${result.error ?? "unknown error"}`,
    };
  }
  if (action === "remove" || action === "rm") {
    if (!target) return { kind: "instant", feedback: "Usage: /marketplace remove <name>" };
    return {
      kind: "instant",
      feedback: removeKnownMarketplace(target)
        ? `Removed marketplace ${target}.`
        : `Marketplace not found: ${target}`,
    };
  }
  if (action === "update") {
    const selected = target ? getKnownMarketplace(target) : undefined;
    if (target && !selected) {
      return { kind: "instant", feedback: `Marketplace not found: ${target}` };
    }
    const entries = selected ? [selected] : listAvailableMarketplaces();
    if (entries.length === 0) {
      return { kind: "instant", feedback: "No marketplaces configured." };
    }
    const results: AddMarketplaceResult[] = [];
    for (const entry of entries) results.push(await addMarketplace(entry.source));
    if (selected) return { kind: "instant", feedback: marketplaceUpdateFeedback(results[0]!) };
    const succeeded = results.filter((result) => result.ok);
    const bumped = succeeded.reduce((total, result) => total + (result.bumped ?? 0), 0);
    const failed = results.filter((result) => !result.ok);
    return {
      kind: "instant",
      feedback: failed.length
        ? `Updated ${succeeded.length} marketplaces, ${bumped} plugin${bumped === 1 ? "" : "s"} bumped. ${failed.length} failed.`
        : `Updated ${succeeded.length} marketplaces, ${bumped} plugin${bumped === 1 ? "" : "s"} bumped.`,
    };
  }
  return { kind: "instant", feedback: `Unknown command: /marketplace ${action}` };
}

export async function handlePlugins(args: string): Promise<SlashResult> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase() || "list";
  const target = parts[1];

  if (sub === "marketplace" || sub === "market") {
    return handleMarketplace(parts.slice(1).join(" "));
  }

  switch (sub) {
    case "list": {
      const all = plugins.list();
      if (all.length === 0) {
        return { kind: "instant", feedback: "No plugins installed." };
      }
      const lines = all.map(({ pluginId, plugin }) => {
        const installation = findPluginInstallation(pluginId);
        const status = plugins.isEnabled(pluginId) ? "enabled" : "disabled";
        const origin = installation ? ` · ${installation.marketplace} · ${installation.scope}` : "";
        return `• ${pluginId} Plugin${origin} · v${plugin.manifest.version || "0.0.0"} · ${status}`;
      });
      return { kind: "instant", feedback: ["Installed plugins:", ...lines].join("\n") };
    }
    case "enable": {
      if (!target)
        return { kind: "instant", feedback: "Usage: /plugin enable <plugin@marketplace>" };
      const resolved = resolvePluginCommandTarget(target);
      if (!resolved.ok) return { kind: "instant", feedback: lookupFeedback(resolved) };
      const result = await changeEnabledWithDependencies(resolved.pluginId, true);
      return { kind: "instant", feedback: result.message };
    }
    case "disable": {
      if (!target)
        return { kind: "instant", feedback: "Usage: /plugin disable <plugin@marketplace>" };
      const resolved = resolvePluginCommandTarget(target);
      if (!resolved.ok) return { kind: "instant", feedback: lookupFeedback(resolved) };
      const result = await changeEnabledWithDependencies(resolved.pluginId, false);
      return { kind: "instant", feedback: result.message };
    }
    case "install": {
      const parsed = requestedScope(parts.slice(1));
      if (parsed.error) return { kind: "instant", feedback: parsed.error };
      const installTarget = parsed.args[0];
      if (!installTarget) {
        return {
          kind: "instant",
          feedback: "Usage: /plugin install <plugin@marketplace> [--scope scope]",
        };
      }
      return {
        kind: "instant",
        feedback: installRequested(installTarget, parsed.args, parsed.scope).message,
      };
    }
    case "update": {
      const parsed = requestedScope(parts.slice(1));
      if (parsed.error) return { kind: "instant", feedback: parsed.error };
      const updateTarget = parsed.args[0];
      if (!updateTarget) {
        return {
          kind: "instant",
          feedback: "Usage: /plugin update <installation-id> [--scope scope]",
        };
      }
      const resolved = lookupPluginInstallation(updateTarget, {
        ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
      });
      if (!resolved.ok) return { kind: "instant", feedback: lookupFeedback(resolved) };
      const res = updateMarketplacePlugin(
        resolved.pluginId,
        parsed.scope,
        resolved.installation.installationId,
      );
      return { kind: "instant", feedback: res.message };
    }
    case "remove":
    case "uninstall": {
      if (!target) {
        return { kind: "instant", feedback: "Usage: /plugin uninstall <plugin@marketplace>" };
      }
      const resolved = resolveUninstallTarget(target);
      if (!resolved.ok) return { kind: "instant", feedback: lookupFeedback(resolved) };
      const dependents = reverseDependents(resolved.pluginId, registryDependencyPlugins());
      const res = await removePlugin(resolved.pluginId);
      return {
        kind: "instant",
        feedback: `${res.message}${res.success ? requiredByWarning(dependents) : ""}`,
      };
    }
    default:
      return { kind: "instant", feedback: `Unknown command: /plugins ${sub}` };
  }
}

/**
 * Installing whatever the reader named: a plugin written `name@marketplace`, a
 * bare name a marketplace claims, or a path. Named first, claimed second — a
 * reader who wrote the marketplace out meant that one.
 */
function installRequested(
  target: string,
  args: readonly string[],
  scope: InstallScope | undefined,
): { message: string } {
  const separator = target.lastIndexOf("@");
  if (separator > 0) {
    return installMarketplacePlugin(target.slice(separator + 1), target.slice(0, separator), scope);
  }
  const claimed = findMarketplacePlugin(target);
  if (claimed) return installMarketplacePlugin(claimed.marketplace, claimed.entry.name, scope);
  return installPlugin(args.join(" "), scope === undefined ? {} : { scope });
}
