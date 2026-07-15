import Yoga, {
  Align,
  Direction,
  Display,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Wrap,
  type Node as YogaNode,
} from "@/native-ts/yoga-layout/index.js";
import {
  type LayoutClipping,
  type LayoutContentJustify,
  type LayoutElement,
  type LayoutItemAlign,
  type LayoutMeasureCallback,
  LayoutMeasurement,
  type LayoutOrientation,
  type LayoutPositioning,
  type LayoutSide,
  type LayoutSpacing,
  LayoutVisibility,
  type LayoutWrapping,
} from "@/terminal-runtime/geometry/layout-element.js";

const EDGE_TRANSLATION_MAP: Record<LayoutSide, Edge> = {
  all: Edge.All,
  horizontal: Edge.Horizontal,
  vertical: Edge.Vertical,
  left: Edge.Left,
  right: Edge.Right,
  top: Edge.Top,
  bottom: Edge.Bottom,
  start: Edge.Start,
  end: Edge.End,
};

const GUTTER_TRANSLATION_MAP: Record<LayoutSpacing, Gutter> = {
  all: Gutter.All,
  column: Gutter.Column,
  row: Gutter.Row,
};

export class FlexLayoutAdapter implements LayoutElement {
  readonly yoga: YogaNode;

  constructor(yoga: YogaNode) {
    this.yoga = yoga;
  }

  insertChild(child: LayoutElement, index: number): void {
    this.yoga.insertChild((child as FlexLayoutAdapter).yoga, index);
  }

  removeChild(child: LayoutElement): void {
    this.yoga.removeChild((child as FlexLayoutAdapter).yoga);
  }

  getChildCount(): number {
    return this.yoga.getChildCount();
  }

  getParent(): LayoutElement | null {
    const p = this.yoga.getParent();
    return p ? new FlexLayoutAdapter(p) : null;
  }

  calculateLayout(width?: number, _height?: number): void {
    this.yoga.calculateLayout(width, undefined, Direction.LTR);
  }

  setMeasureFunc(fn: LayoutMeasureCallback): void {
    this.yoga.setMeasureFunc((w, wMode) => {
      const mode =
        wMode === MeasureMode.Exactly
          ? LayoutMeasurement.Exactly
          : wMode === MeasureMode.AtMost
            ? LayoutMeasurement.AtMost
            : LayoutMeasurement.Undefined;
      return fn(w, mode);
    });
  }

  unsetMeasureFunc(): void {
    this.yoga.unsetMeasureFunc();
  }

  invalidateLayout(): void {
    this.yoga.invalidateLayout();
  }

  getComputedLeft(): number {
    return this.yoga.getComputedLeft();
  }

  getComputedTop(): number {
    return this.yoga.getComputedTop();
  }

  getComputedWidth(): number {
    return this.yoga.getComputedWidth();
  }

  getComputedHeight(): number {
    return this.yoga.getComputedHeight();
  }

  getComputedBorder(edge: LayoutSide): number {
    return this.yoga.getComputedBorder(EDGE_TRANSLATION_MAP[edge]!);
  }

  getComputedPadding(edge: LayoutSide): number {
    return this.yoga.getComputedPadding(EDGE_TRANSLATION_MAP[edge]!);
  }

  setWidth(value: number): void {
    this.yoga.setWidth(value);
  }
  setWidthPercent(value: number): void {
    this.yoga.setWidthPercent(value);
  }
  setWidthAuto(): void {
    this.yoga.setWidthAuto();
  }
  setHeight(value: number): void {
    this.yoga.setHeight(value);
  }
  setHeightPercent(value: number): void {
    this.yoga.setHeightPercent(value);
  }
  setHeightAuto(): void {
    this.yoga.setHeightAuto();
  }
  setMinWidth(value: number): void {
    this.yoga.setMinWidth(value);
  }
  setMinWidthPercent(value: number): void {
    this.yoga.setMinWidthPercent(value);
  }
  setMinHeight(value: number): void {
    this.yoga.setMinHeight(value);
  }
  setMinHeightPercent(value: number): void {
    this.yoga.setMinHeightPercent(value);
  }
  setMaxWidth(value: number): void {
    this.yoga.setMaxWidth(value);
  }
  setMaxWidthPercent(value: number): void {
    this.yoga.setMaxWidthPercent(value);
  }
  setMaxHeight(value: number): void {
    this.yoga.setMaxHeight(value);
  }
  setMaxHeightPercent(value: number): void {
    this.yoga.setMaxHeightPercent(value);
  }

  setFlexDirection(dir: LayoutOrientation): void {
    const map: Record<LayoutOrientation, FlexDirection> = {
      row: FlexDirection.Row,
      "row-reverse": FlexDirection.RowReverse,
      column: FlexDirection.Column,
      "column-reverse": FlexDirection.ColumnReverse,
    };
    this.yoga.setFlexDirection(map[dir]!);
  }

  setFlexGrow(value: number): void {
    this.yoga.setFlexGrow(value);
  }
  setFlexShrink(value: number): void {
    this.yoga.setFlexShrink(value);
  }
  setFlexBasis(value: number): void {
    this.yoga.setFlexBasis(value);
  }
  setFlexBasisPercent(value: number): void {
    this.yoga.setFlexBasisPercent(value);
  }

  setFlexWrap(wrap: LayoutWrapping): void {
    const map: Record<LayoutWrapping, Wrap> = {
      nowrap: Wrap.NoWrap,
      wrap: Wrap.Wrap,
      "wrap-reverse": Wrap.WrapReverse,
    };
    this.yoga.setFlexWrap(map[wrap]!);
  }

  setAlignItems(align: LayoutItemAlign): void {
    const map: Record<LayoutItemAlign, Align> = {
      auto: Align.Auto,
      stretch: Align.Stretch,
      "flex-start": Align.FlexStart,
      center: Align.Center,
      "flex-end": Align.FlexEnd,
    };
    this.yoga.setAlignItems(map[align]!);
  }

  setAlignSelf(align: LayoutItemAlign): void {
    const map: Record<LayoutItemAlign, Align> = {
      auto: Align.Auto,
      stretch: Align.Stretch,
      "flex-start": Align.FlexStart,
      center: Align.Center,
      "flex-end": Align.FlexEnd,
    };
    this.yoga.setAlignSelf(map[align]!);
  }

  setJustifyContent(justify: LayoutContentJustify): void {
    const map: Record<LayoutContentJustify, Justify> = {
      "flex-start": Justify.FlexStart,
      center: Justify.Center,
      "flex-end": Justify.FlexEnd,
      "space-between": Justify.SpaceBetween,
      "space-around": Justify.SpaceAround,
      "space-evenly": Justify.SpaceEvenly,
    };
    this.yoga.setJustifyContent(map[justify]!);
  }

  setDisplay(display: LayoutVisibility): void {
    this.yoga.setDisplay(display === "flex" ? Display.Flex : Display.None);
  }

  getDisplay(): LayoutVisibility {
    return this.yoga.getDisplay() === Display.None ? LayoutVisibility.None : LayoutVisibility.Flex;
  }

  setPositionType(type: LayoutPositioning): void {
    this.yoga.setPositionType(type === "absolute" ? PositionType.Absolute : PositionType.Relative);
  }

  setPosition(edge: LayoutSide, value: number): void {
    this.yoga.setPosition(EDGE_TRANSLATION_MAP[edge]!, value);
  }

  setPositionPercent(edge: LayoutSide, value: number): void {
    this.yoga.setPositionPercent(EDGE_TRANSLATION_MAP[edge]!, value);
  }

  setOverflow(overflow: LayoutClipping): void {
    const map: Record<LayoutClipping, Overflow> = {
      visible: Overflow.Visible,
      hidden: Overflow.Hidden,
      scroll: Overflow.Scroll,
    };
    this.yoga.setOverflow(map[overflow]!);
  }

  setMargin(edge: LayoutSide, value: number): void {
    this.yoga.setMargin(EDGE_TRANSLATION_MAP[edge]!, value);
  }
  setPadding(edge: LayoutSide, value: number): void {
    this.yoga.setPadding(EDGE_TRANSLATION_MAP[edge]!, value);
  }
  setBorder(edge: LayoutSide, value: number): void {
    this.yoga.setBorder(EDGE_TRANSLATION_MAP[edge]!, value);
  }
  setGap(gutter: LayoutSpacing, value: number): void {
    this.yoga.setGap(GUTTER_TRANSLATION_MAP[gutter]!, value);
  }

  free(): void {
    this.yoga.free();
  }
  freeRecursive(): void {
    this.yoga.freeRecursive();
  }
}

export function createFlexLayoutAdapter(): LayoutElement {
  return new FlexLayoutAdapter(Yoga.Node.create());
}
