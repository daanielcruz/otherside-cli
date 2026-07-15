import {
  LayoutClipping,
  LayoutContentJustify,
  type LayoutElement,
  LayoutItemAlign,
  LayoutOrientation,
  LayoutPositioning,
  LayoutSide,
  LayoutSpacing,
  LayoutVisibility,
  LayoutWrapping,
} from "@/terminal-runtime/geometry/layout-element.js";
import type { BorderStyle, BorderTextOptions } from "@/terminal-runtime/paint/border-strokes.js";

export type RGBColor = `rgb(${number},${number},${number})`;
export type HexColor = `#${string}`;
export type Ansi256Color = `ansi256(${number})`;
export type AnsiColor =
  | "ansi:black"
  | "ansi:red"
  | "ansi:green"
  | "ansi:yellow"
  | "ansi:blue"
  | "ansi:magenta"
  | "ansi:cyan"
  | "ansi:white"
  | "ansi:blackBright"
  | "ansi:redBright"
  | "ansi:greenBright"
  | "ansi:yellowBright"
  | "ansi:blueBright"
  | "ansi:magentaBright"
  | "ansi:cyanBright"
  | "ansi:whiteBright";

export type TerminalColor = RGBColor | HexColor | Ansi256Color | AnsiColor;

export type TerminalTextStyle = {
  readonly color?: TerminalColor;
  readonly backgroundColor?: TerminalColor;
  readonly dim?: boolean;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly inverse?: boolean;
};

export type Styles = {
  readonly textWrap?:
    | "wrap"
    | "wrap-trim"
    | "wrap-stream"
    | "end"
    | "middle"
    | "truncate-end"
    | "truncate"
    | "truncate-middle"
    | "truncate-start";

  readonly position?: "absolute" | "relative";
  readonly top?: number | `${number}%`;
  readonly bottom?: number | `${number}%`;
  readonly left?: number | `${number}%`;
  readonly right?: number | `${number}%`;

  readonly columnGap?: number;

  readonly rowGap?: number;

  readonly gap?: number;

  readonly margin?: number;

  readonly marginX?: number;

  readonly marginY?: number;

  readonly marginTop?: number;

  readonly marginBottom?: number;

  readonly marginLeft?: number;

  readonly marginRight?: number;

  readonly padding?: number;

  readonly paddingX?: number;

  readonly paddingY?: number;

  readonly paddingTop?: number;

  readonly paddingBottom?: number;

  readonly paddingLeft?: number;

  readonly paddingRight?: number;

  readonly flexGrow?: number;

  readonly flexShrink?: number;

  readonly flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";

  readonly flexBasis?: number | string;

  readonly flexWrap?: "nowrap" | "wrap" | "wrap-reverse";

  readonly alignItems?: "flex-start" | "center" | "flex-end" | "stretch";

  readonly alignSelf?: "flex-start" | "center" | "flex-end" | "auto";

  readonly justifyContent?:
    | "flex-start"
    | "flex-end"
    | "space-between"
    | "space-around"
    | "space-evenly"
    | "center";

  readonly width?: number | string;

  readonly height?: number | string;

  readonly minWidth?: number | string;

  readonly minHeight?: number | string;

  readonly maxWidth?: number | string;

  readonly maxHeight?: number | string;

  readonly display?: "flex" | "none";

  readonly borderStyle?: BorderStyle;

  readonly borderTop?: boolean;

  readonly borderBottom?: boolean;

  readonly borderLeft?: boolean;

  readonly borderRight?: boolean;

  readonly borderColor?: TerminalColor;

  readonly borderTopColor?: TerminalColor;

  readonly borderBottomColor?: TerminalColor;

  readonly borderLeftColor?: TerminalColor;

  readonly borderRightColor?: TerminalColor;

  readonly borderDimColor?: boolean;

  readonly borderTopDimColor?: boolean;

  readonly borderBottomDimColor?: boolean;

  readonly borderLeftDimColor?: boolean;

  readonly borderRightDimColor?: boolean;

  readonly borderText?: BorderTextOptions;

  readonly backgroundColor?: TerminalColor;

  readonly opaque?: boolean;

  readonly overflow?: "visible" | "hidden";

  readonly overflowX?: "visible" | "hidden";

  readonly overflowY?: "visible" | "hidden";
};

const applyPositionStyles = (node: LayoutElement, style: Styles): void => {
  if ("position" in style) {
    node.setPositionType(
      style.position === "absolute" ? LayoutPositioning.Absolute : LayoutPositioning.Relative,
    );
  }
  if ("top" in style) applyPositionEdge(node, "top", style.top);
  if ("bottom" in style) applyPositionEdge(node, "bottom", style.bottom);
  if ("left" in style) applyPositionEdge(node, "left", style.left);
  if ("right" in style) applyPositionEdge(node, "right", style.right);
};

function applyPositionEdge(
  node: LayoutElement,
  edge: "top" | "bottom" | "left" | "right",
  v: number | `${number}%` | undefined,
): void {
  if (typeof v === "string") {
    node.setPositionPercent(edge, Number.parseInt(v, 10));
  } else if (typeof v === "number") {
    node.setPosition(edge, v);
  } else {
    node.setPosition(edge, Number.NaN);
  }
}

const applyOverflowStyles = (node: LayoutElement, style: Styles): void => {
  const y = style.overflowY ?? style.overflow;
  const x = style.overflowX ?? style.overflow;
  if (y === "hidden" || x === "hidden") {
    node.setOverflow(LayoutClipping.Hidden);
  } else if ("overflow" in style || "overflowX" in style || "overflowY" in style) {
    node.setOverflow(LayoutClipping.Visible);
  }
};

const applyMarginStyles = (node: LayoutElement, style: Styles): void => {
  if ("margin" in style) {
    node.setMargin(LayoutSide.All, style.margin ?? 0);
  }

  if ("marginX" in style) {
    node.setMargin(LayoutSide.Horizontal, style.marginX ?? 0);
  }

  if ("marginY" in style) {
    node.setMargin(LayoutSide.Vertical, style.marginY ?? 0);
  }

  if ("marginLeft" in style) {
    node.setMargin(LayoutSide.Start, style.marginLeft || 0);
  }

  if ("marginRight" in style) {
    node.setMargin(LayoutSide.End, style.marginRight || 0);
  }

  if ("marginTop" in style) {
    node.setMargin(LayoutSide.Top, style.marginTop || 0);
  }

  if ("marginBottom" in style) {
    node.setMargin(LayoutSide.Bottom, style.marginBottom || 0);
  }
};

const applyPaddingStyles = (node: LayoutElement, style: Styles): void => {
  if ("padding" in style) {
    node.setPadding(LayoutSide.All, style.padding ?? 0);
  }

  if ("paddingX" in style) {
    node.setPadding(LayoutSide.Horizontal, style.paddingX ?? 0);
  }

  if ("paddingY" in style) {
    node.setPadding(LayoutSide.Vertical, style.paddingY ?? 0);
  }

  if ("paddingLeft" in style) {
    node.setPadding(LayoutSide.Left, style.paddingLeft || 0);
  }

  if ("paddingRight" in style) {
    node.setPadding(LayoutSide.Right, style.paddingRight || 0);
  }

  if ("paddingTop" in style) {
    node.setPadding(LayoutSide.Top, style.paddingTop || 0);
  }

  if ("paddingBottom" in style) {
    node.setPadding(LayoutSide.Bottom, style.paddingBottom || 0);
  }
};

const applyFlexStyles = (node: LayoutElement, style: Styles): void => {
  if ("flexGrow" in style) {
    node.setFlexGrow(style.flexGrow ?? 0);
  }

  if ("flexShrink" in style) {
    node.setFlexShrink(typeof style.flexShrink === "number" ? style.flexShrink : 1);
  }

  if ("flexWrap" in style) {
    if (style.flexWrap === "nowrap") {
      node.setFlexWrap(LayoutWrapping.NoWrap);
    }

    if (style.flexWrap === "wrap") {
      node.setFlexWrap(LayoutWrapping.Wrap);
    }

    if (style.flexWrap === "wrap-reverse") {
      node.setFlexWrap(LayoutWrapping.WrapReverse);
    }
  }

  if ("flexDirection" in style) {
    if (style.flexDirection === "row") {
      node.setFlexDirection(LayoutOrientation.Row);
    }

    if (style.flexDirection === "row-reverse") {
      node.setFlexDirection(LayoutOrientation.RowReverse);
    }

    if (style.flexDirection === "column") {
      node.setFlexDirection(LayoutOrientation.Column);
    }

    if (style.flexDirection === "column-reverse") {
      node.setFlexDirection(LayoutOrientation.ColumnReverse);
    }
  }

  if ("flexBasis" in style) {
    if (typeof style.flexBasis === "number") {
      node.setFlexBasis(style.flexBasis);
    } else if (typeof style.flexBasis === "string") {
      node.setFlexBasisPercent(Number.parseInt(style.flexBasis, 10));
    } else {
      node.setFlexBasis(Number.NaN);
    }
  }

  if ("alignItems" in style) {
    if (style.alignItems === "stretch" || !style.alignItems) {
      node.setAlignItems(LayoutItemAlign.Stretch);
    }

    if (style.alignItems === "flex-start") {
      node.setAlignItems(LayoutItemAlign.FlexStart);
    }

    if (style.alignItems === "center") {
      node.setAlignItems(LayoutItemAlign.Center);
    }

    if (style.alignItems === "flex-end") {
      node.setAlignItems(LayoutItemAlign.FlexEnd);
    }
  }

  if ("alignSelf" in style) {
    if (style.alignSelf === "auto" || !style.alignSelf) {
      node.setAlignSelf(LayoutItemAlign.Auto);
    }

    if (style.alignSelf === "flex-start") {
      node.setAlignSelf(LayoutItemAlign.FlexStart);
    }

    if (style.alignSelf === "center") {
      node.setAlignSelf(LayoutItemAlign.Center);
    }

    if (style.alignSelf === "flex-end") {
      node.setAlignSelf(LayoutItemAlign.FlexEnd);
    }
  }

  if ("justifyContent" in style) {
    if (style.justifyContent === "flex-start" || !style.justifyContent) {
      node.setJustifyContent(LayoutContentJustify.FlexStart);
    }

    if (style.justifyContent === "center") {
      node.setJustifyContent(LayoutContentJustify.Center);
    }

    if (style.justifyContent === "flex-end") {
      node.setJustifyContent(LayoutContentJustify.FlexEnd);
    }

    if (style.justifyContent === "space-between") {
      node.setJustifyContent(LayoutContentJustify.SpaceBetween);
    }

    if (style.justifyContent === "space-around") {
      node.setJustifyContent(LayoutContentJustify.SpaceAround);
    }

    if (style.justifyContent === "space-evenly") {
      node.setJustifyContent(LayoutContentJustify.SpaceEvenly);
    }
  }
};

const applyDimensionStyles = (node: LayoutElement, style: Styles): void => {
  if ("width" in style) {
    if (typeof style.width === "number") {
      node.setWidth(style.width);
    } else if (typeof style.width === "string") {
      node.setWidthPercent(Number.parseInt(style.width, 10));
    } else {
      node.setWidthAuto();
    }
  }

  if ("height" in style) {
    if (typeof style.height === "number") {
      node.setHeight(style.height);
    } else if (typeof style.height === "string") {
      node.setHeightPercent(Number.parseInt(style.height, 10));
    } else {
      node.setHeightAuto();
    }
  }

  if ("minWidth" in style) {
    if (typeof style.minWidth === "string") {
      node.setMinWidthPercent(Number.parseInt(style.minWidth, 10));
    } else {
      node.setMinWidth(style.minWidth ?? 0);
    }
  }

  if ("minHeight" in style) {
    if (typeof style.minHeight === "string") {
      node.setMinHeightPercent(Number.parseInt(style.minHeight, 10));
    } else {
      node.setMinHeight(style.minHeight ?? 0);
    }
  }

  if ("maxWidth" in style) {
    if (typeof style.maxWidth === "string") {
      node.setMaxWidthPercent(Number.parseInt(style.maxWidth, 10));
    } else {
      node.setMaxWidth(style.maxWidth ?? 0);
    }
  }

  if ("maxHeight" in style) {
    if (typeof style.maxHeight === "string") {
      node.setMaxHeightPercent(Number.parseInt(style.maxHeight, 10));
    } else {
      node.setMaxHeight(style.maxHeight ?? 0);
    }
  }
};

const applyDisplayStyles = (node: LayoutElement, style: Styles): void => {
  if ("display" in style) {
    node.setDisplay(style.display === "flex" ? LayoutVisibility.Flex : LayoutVisibility.None);
  }
};

const applyBorderStyles = (node: LayoutElement, style: Styles, resolvedStyle?: Styles): void => {
  const resolved = resolvedStyle ?? style;

  if ("borderStyle" in style) {
    const borderWidth = style.borderStyle ? 1 : 0;

    node.setBorder(LayoutSide.Top, resolved.borderTop !== false ? borderWidth : 0);
    node.setBorder(LayoutSide.Bottom, resolved.borderBottom !== false ? borderWidth : 0);
    node.setBorder(LayoutSide.Left, resolved.borderLeft !== false ? borderWidth : 0);
    node.setBorder(LayoutSide.Right, resolved.borderRight !== false ? borderWidth : 0);
  } else {
    if ("borderTop" in style && style.borderTop !== undefined) {
      node.setBorder(LayoutSide.Top, style.borderTop === false ? 0 : 1);
    }
    if ("borderBottom" in style && style.borderBottom !== undefined) {
      node.setBorder(LayoutSide.Bottom, style.borderBottom === false ? 0 : 1);
    }
    if ("borderLeft" in style && style.borderLeft !== undefined) {
      node.setBorder(LayoutSide.Left, style.borderLeft === false ? 0 : 1);
    }
    if ("borderRight" in style && style.borderRight !== undefined) {
      node.setBorder(LayoutSide.Right, style.borderRight === false ? 0 : 1);
    }
  }
};

const applyGapStyles = (node: LayoutElement, style: Styles): void => {
  if ("gap" in style) {
    node.setGap(LayoutSpacing.All, style.gap ?? 0);
  }

  if ("columnGap" in style) {
    node.setGap(LayoutSpacing.Column, style.columnGap ?? 0);
  }

  if ("rowGap" in style) {
    node.setGap(LayoutSpacing.Row, style.rowGap ?? 0);
  }
};

const styles = (node: LayoutElement, style: Styles = {}, resolvedStyle?: Styles): void => {
  applyPositionStyles(node, style);
  applyOverflowStyles(node, style);
  applyMarginStyles(node, style);
  applyPaddingStyles(node, style);
  applyFlexStyles(node, style);
  applyDimensionStyles(node, style);
  applyDisplayStyles(node, style);
  applyBorderStyles(node, style, resolvedStyle);
  applyGapStyles(node, style);
};

export default styles;
