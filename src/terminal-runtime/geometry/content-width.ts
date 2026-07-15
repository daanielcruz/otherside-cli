import { type LayoutElement, LayoutSide } from "@/terminal-runtime/geometry/layout-element.js";

const computeAvailableWidth = (yogaNode: LayoutElement): number => {
  return (
    yogaNode.getComputedWidth() -
    yogaNode.getComputedPadding(LayoutSide.Left) -
    yogaNode.getComputedPadding(LayoutSide.Right) -
    yogaNode.getComputedBorder(LayoutSide.Left) -
    yogaNode.getComputedBorder(LayoutSide.Right)
  );
};

export default computeAvailableWidth;
