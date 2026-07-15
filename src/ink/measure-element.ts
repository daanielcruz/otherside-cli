import type { TreeElement } from "@/terminal-runtime/tree/elements.js";

type Output = {
  width: number;

  height: number;
};

const measureElement = (node: TreeElement): Output => ({
  width: node.yogaNode?.getComputedWidth() ?? 0,
  height: node.yogaNode?.getComputedHeight() ?? 0,
});

export default measureElement;
