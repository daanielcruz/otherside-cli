import type { LayoutElement } from "@/terminal-runtime/geometry/layout-element.js";
import { createFlexLayoutAdapter } from "@/terminal-runtime/geometry/yoga-adapter.js";

export function buildLayoutNode(): LayoutElement {
  return createFlexLayoutAdapter();
}
