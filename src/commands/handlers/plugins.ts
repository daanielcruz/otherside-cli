import type { SlashResult } from "@/commands/types.ts";
import { installPlugin, removePlugin } from "@/engine/plugins/install.ts";
import { findPluginInstallation } from "@/engine/plugins/installations.ts";
import {
  addMarketplace,
  findMarketplacePlugin,
  installMarketplacePlugin,
  updateMarketplacePlugin,
} from "@/engine/plugins/marketplace.ts";
import {
  getKnownMarketplace,
  listAvailableMarketplaces,
  removeKnownMarketplace,
} from "@/engine/plugins/marketplaces-store.ts";
import * as plugins from "@/engine/plugins/registry.ts";

function marketplaceUpdateFeedback(result: ReturnType<typeof addMarketplace>): string {
  if (!result.ok) return `Marketplace update failed: ${result.error ?? "unknown error"}`;
  const bumped = result.bumped ?? 0;
  return `Updated marketplace ${result.name}: ${result.count ?? 0} plugins, ${bumped} plugin${bumped === 1 ? "" : "s"} bumped.`;
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
    const result = addMarketplace(target);
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
    const results = entries.map((entry) => addMarketplace(entry.source));
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
      const lines = all.map((p) => {
        const installation = findPluginInstallation(p.name);
        const identity = installation?.identity ?? p.name;
        const status = plugins.isEnabled(identity) ? "enabled" : "disabled";
        const origin = installation ? ` · ${installation.marketplace} · ${installation.scope}` : "";
        return `• ${identity} Plugin${origin} · v${p.manifest.version || "0.0.0"} · ${status}`;
      });
      return { kind: "instant", feedback: ["Installed plugins:", ...lines].join("\n") };
    }
    case "enable": {
      if (!target)
        return { kind: "instant", feedback: "Usage: /plugin enable <plugin@marketplace>" };
      if (!plugins.get(target)) {
        return { kind: "instant", feedback: `Plugin not found: ${target}` };
      }
      await plugins.setEnabled(target, true);
      return {
        kind: "instant",
        feedback: target.includes("@")
          ? `Enabled plugin ${target}.`
          : `Enabled plugin ${target}. Run /reload-plugins to apply.`,
      };
    }
    case "disable": {
      if (!target)
        return { kind: "instant", feedback: "Usage: /plugin disable <plugin@marketplace>" };
      if (!plugins.get(target)) {
        return { kind: "instant", feedback: `Plugin not found: ${target}` };
      }
      await plugins.setEnabled(target, false);
      return {
        kind: "instant",
        feedback: target.includes("@")
          ? `Disabled plugin ${target}.`
          : `Disabled plugin ${target}. Run /reload-plugins to apply.`,
      };
    }
    case "install": {
      if (!target)
        return { kind: "instant", feedback: "Usage: /plugin install <plugin@marketplace>" };
      const separator = target.lastIndexOf("@");
      const marketplaceMatch = separator < 1 ? findMarketplacePlugin(target) : null;
      const res =
        separator > 0
          ? installMarketplacePlugin(target.slice(separator + 1), target.slice(0, separator))
          : marketplaceMatch
            ? installMarketplacePlugin(marketplaceMatch.marketplace, marketplaceMatch.entry.name)
            : installPlugin(parts.slice(1).join(" "));
      return { kind: "instant", feedback: res.message };
    }
    case "update": {
      if (!target)
        return { kind: "instant", feedback: "Usage: /plugin update <plugin@marketplace>" };
      const res = updateMarketplacePlugin(target);
      return { kind: "instant", feedback: res.message };
    }
    case "remove":
    case "uninstall": {
      if (!target) {
        return { kind: "instant", feedback: "Usage: /plugin uninstall <plugin@marketplace>" };
      }
      const res = await removePlugin(target);
      return { kind: "instant", feedback: res.message };
    }
    default:
      return { kind: "instant", feedback: `Unknown command: /plugins ${sub}` };
  }
}
