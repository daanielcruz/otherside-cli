export const LayoutSide = {
  All: "all",
  Horizontal: "horizontal",
  Vertical: "vertical",
  Left: "left",
  Right: "right",
  Top: "top",
  Bottom: "bottom",
  Start: "start",
  End: "end",
} as const;
export type LayoutSide = (typeof LayoutSide)[keyof typeof LayoutSide];

export const LayoutSpacing = {
  All: "all",
  Column: "column",
  Row: "row",
} as const;
export type LayoutSpacing = (typeof LayoutSpacing)[keyof typeof LayoutSpacing];

export const LayoutVisibility = {
  Flex: "flex",
  None: "none",
} as const;
export type LayoutVisibility = (typeof LayoutVisibility)[keyof typeof LayoutVisibility];

export const LayoutOrientation = {
  Row: "row",
  RowReverse: "row-reverse",
  Column: "column",
  ColumnReverse: "column-reverse",
} as const;
export type LayoutOrientation = (typeof LayoutOrientation)[keyof typeof LayoutOrientation];

export const LayoutItemAlign = {
  Auto: "auto",
  Stretch: "stretch",
  FlexStart: "flex-start",
  Center: "center",
  FlexEnd: "flex-end",
} as const;
export type LayoutItemAlign = (typeof LayoutItemAlign)[keyof typeof LayoutItemAlign];

export const LayoutContentJustify = {
  FlexStart: "flex-start",
  Center: "center",
  FlexEnd: "flex-end",
  SpaceBetween: "space-between",
  SpaceAround: "space-around",
  SpaceEvenly: "space-evenly",
} as const;
export type LayoutContentJustify = (typeof LayoutContentJustify)[keyof typeof LayoutContentJustify];

export const LayoutWrapping = {
  NoWrap: "nowrap",
  Wrap: "wrap",
  WrapReverse: "wrap-reverse",
} as const;
export type LayoutWrapping = (typeof LayoutWrapping)[keyof typeof LayoutWrapping];

export const LayoutPositioning = {
  Relative: "relative",
  Absolute: "absolute",
} as const;
export type LayoutPositioning = (typeof LayoutPositioning)[keyof typeof LayoutPositioning];

export const LayoutClipping = {
  Visible: "visible",
  Hidden: "hidden",
  Scroll: "scroll",
} as const;
export type LayoutClipping = (typeof LayoutClipping)[keyof typeof LayoutClipping];

export type LayoutMeasureCallback = (
  width: number,
  widthMode: LayoutMeasurement,
) => { width: number; height: number };

export const LayoutMeasurement = {
  Undefined: "undefined",
  Exactly: "exactly",
  AtMost: "at-most",
} as const;
export type LayoutMeasurement = (typeof LayoutMeasurement)[keyof typeof LayoutMeasurement];

export type LayoutElement = {
  insertChild(child: LayoutElement, index: number): void;
  removeChild(child: LayoutElement): void;
  getChildCount(): number;
  getParent(): LayoutElement | null;

  calculateLayout(width?: number, height?: number): void;
  setMeasureFunc(fn: LayoutMeasureCallback): void;
  unsetMeasureFunc(): void;
  invalidateLayout(): void;

  getComputedLeft(): number;
  getComputedTop(): number;
  getComputedWidth(): number;
  getComputedHeight(): number;
  getComputedBorder(edge: LayoutSide): number;
  getComputedPadding(edge: LayoutSide): number;

  setWidth(value: number): void;
  setWidthPercent(value: number): void;
  setWidthAuto(): void;
  setHeight(value: number): void;
  setHeightPercent(value: number): void;
  setHeightAuto(): void;
  setMinWidth(value: number): void;
  setMinWidthPercent(value: number): void;
  setMinHeight(value: number): void;
  setMinHeightPercent(value: number): void;
  setMaxWidth(value: number): void;
  setMaxWidthPercent(value: number): void;
  setMaxHeight(value: number): void;
  setMaxHeightPercent(value: number): void;
  setFlexDirection(dir: LayoutOrientation): void;
  setFlexGrow(value: number): void;
  setFlexShrink(value: number): void;
  setFlexBasis(value: number): void;
  setFlexBasisPercent(value: number): void;
  setFlexWrap(wrap: LayoutWrapping): void;
  setAlignItems(align: LayoutItemAlign): void;
  setAlignSelf(align: LayoutItemAlign): void;
  setJustifyContent(justify: LayoutContentJustify): void;
  setDisplay(display: LayoutVisibility): void;
  getDisplay(): LayoutVisibility;
  setPositionType(type: LayoutPositioning): void;
  setPosition(edge: LayoutSide, value: number): void;
  setPositionPercent(edge: LayoutSide, value: number): void;
  setOverflow(overflow: LayoutClipping): void;
  setMargin(edge: LayoutSide, value: number): void;
  setPadding(edge: LayoutSide, value: number): void;
  setBorder(edge: LayoutSide, value: number): void;
  setGap(gutter: LayoutSpacing, value: number): void;

  free(): void;
  freeRecursive(): void;
};
