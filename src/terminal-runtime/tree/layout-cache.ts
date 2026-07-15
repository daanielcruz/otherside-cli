import type { Rectangle } from "@/terminal-runtime/geometry/coordinates.js";
import type { TreeElement } from "@/terminal-runtime/tree/elements.js";

export type LayoutSnapshot = {
  x: number;
  y: number;
  width: number;
  height: number;
  top?: number;
};

export const elementDimensionStore = new WeakMap<TreeElement, LayoutSnapshot>();

export const deferredRegions = new WeakMap<TreeElement, Rectangle[]>();

let absoluteElementRemoved = false;

export function queueRegionClear(parent: TreeElement, rect: Rectangle, isAbsolute: boolean): void {
  const existing = deferredRegions.get(parent);
  if (existing) {
    existing.push(rect);
  } else {
    deferredRegions.set(parent, [rect]);
  }
  if (isAbsolute) {
    absoluteElementRemoved = true;
  }
}

export function drainAbsoluteRemovalState(): boolean {
  const had = absoluteElementRemoved;
  absoluteElementRemoved = false;
  return had;
}
