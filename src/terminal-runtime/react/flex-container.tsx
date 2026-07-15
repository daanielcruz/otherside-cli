import React, { type PropsWithChildren, type Ref } from "react";
import type { Except } from "type-fest";
import * as warn from "@/terminal-runtime/diagnostics/warnings.js";
import type { Styles } from "@/terminal-runtime/paint/style-model.js";
import type { TreeElement } from "@/terminal-runtime/tree/elements.js";

export type Props = Except<Styles, "textWrap"> & {
  ref?: Ref<TreeElement> | undefined;
};

function FlexContainer({
  children,
  flexWrap = "nowrap",
  flexDirection = "row",
  flexGrow = 0,
  flexShrink = 1,
  ref,
  ...style
}: PropsWithChildren<Props>): React.ReactNode {
  warn.warnIfNotInteger(style.margin, "margin");
  warn.warnIfNotInteger(style.marginX, "marginX");
  warn.warnIfNotInteger(style.marginY, "marginY");
  warn.warnIfNotInteger(style.marginTop, "marginTop");
  warn.warnIfNotInteger(style.marginBottom, "marginBottom");
  warn.warnIfNotInteger(style.marginLeft, "marginLeft");
  warn.warnIfNotInteger(style.marginRight, "marginRight");
  warn.warnIfNotInteger(style.padding, "padding");
  warn.warnIfNotInteger(style.paddingX, "paddingX");
  warn.warnIfNotInteger(style.paddingY, "paddingY");
  warn.warnIfNotInteger(style.paddingTop, "paddingTop");
  warn.warnIfNotInteger(style.paddingBottom, "paddingBottom");
  warn.warnIfNotInteger(style.paddingLeft, "paddingLeft");
  warn.warnIfNotInteger(style.paddingRight, "paddingRight");
  warn.warnIfNotInteger(style.gap, "gap");
  warn.warnIfNotInteger(style.columnGap, "columnGap");
  warn.warnIfNotInteger(style.rowGap, "rowGap");

  return (
    <ink-box
      ref={ref}
      style={{
        flexWrap,
        flexDirection,
        flexGrow,
        flexShrink,
        ...style,
        overflowX: style.overflowX ?? style.overflow ?? "visible",
        overflowY: style.overflowY ?? style.overflow ?? "visible",
      }}
    >
      {children}
    </ink-box>
  );
}

export default FlexContainer;
