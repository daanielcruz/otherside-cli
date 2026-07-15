import { useSyncExternalStore } from "react";
import { peek as askPeek, subscribe as askSubscribe } from "@/kernel/channels/ask.ts";
import {
  peek as permissionPeek,
  subscribe as permissionSubscribe,
} from "@/kernel/channels/permission.ts";
import { overlayStore } from "@/store/overlay-stack/index.ts";
import type { KeybindingContextName } from "./types.ts";

export type ModalLayer = "permission" | "ask" | "overlay" | "none";

const PRIORITY: Record<ModalLayer, number> = {
  permission: 3,
  ask: 2,
  overlay: 1,
  none: 0,
};

export function topModalLayer(): ModalLayer {
  if (permissionPeek()) return "permission";
  if (askPeek()) return "ask";
  if (overlayStore.getState().openStack.length > 0) return "overlay";
  return "none";
}

export function layerOwnsInput(layer: ModalLayer, top: ModalLayer): boolean {
  return PRIORITY[layer] >= PRIORITY[top];
}

function keybindingContextLayer(context: KeybindingContextName): ModalLayer | null {
  // Keybinding modal ownership is encoded in context names today: overlay
  // dismiss handlers use Overlay:<name>. Permission and ask panels use
  // usePanelNavigation(layer), so unmarked non-global handler contexts are
  // background UI while any modal layer is stacked.
  if (context.startsWith("Overlay:")) return "overlay";
  return null;
}

export function keybindingContextOwnsInput(
  context: KeybindingContextName,
  top: ModalLayer,
): boolean {
  if (context === "Global") return true;
  if (top === "none") return true;

  const layer = keybindingContextLayer(context);
  if (!layer) return false;
  return layerOwnsInput(layer, top);
}

function subscribeAll(onChange: () => void): () => void {
  const unsubscribes = [
    permissionSubscribe(() => onChange()),
    askSubscribe(() => onChange()),
    overlayStore.subscribe(() => onChange()),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

export function useTopModalLayer(): ModalLayer {
  return useSyncExternalStore(subscribeAll, topModalLayer, topModalLayer);
}
