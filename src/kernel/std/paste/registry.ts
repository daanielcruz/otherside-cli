import type { PasteStore } from "@/kernel/std/types/paste.ts";

let active: PasteStore | null = null;

export function setActivePasteStore(store: PasteStore | null): void {
  active = store;
}

export function getActivePasteStore(): PasteStore | null {
  return active;
}
