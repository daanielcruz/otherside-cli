import type { MarketplacePluginEntry } from "@/engine/plugins/marketplace.ts";

export interface PluginsOverlayProps {
  onClose?: () => void;
  /** Optional command feedback shown inside the panel (e.g. after /plugin install). */
  commandResult?: string | null;
}

export const TABS = ["discover", "installed", "marketplaces", "errors"] as const;
export type Tab = (typeof TABS)[number];
export type MarketplaceView = "list" | "details" | "confirm-remove";
export type DiscoverViewMode = "list" | "details";

export interface DiscoverItem {
  marketplace: string;
  entry: MarketplacePluginEntry;
}

export interface PluginSubtitleCounts {
  discover: number;
  installed: number;
  marketplaces: number;
  selected: number;
}
