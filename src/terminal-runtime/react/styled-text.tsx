import type { ReactNode } from "react";
import React from "react";
import type {
  Styles,
  TerminalColor,
  TerminalTextStyle,
} from "@/terminal-runtime/paint/style-model.js";

export type Accessibility = {
  readonly hidden?: boolean | undefined;
  readonly label?: string | undefined;
  readonly role?: string | undefined;
  readonly state?: string | undefined;
};

function createAccessibility(
  hidden?: boolean,
  label?: string,
  role?: string,
  state?: string,
): Accessibility | undefined {
  if (hidden === undefined && label === undefined && role === undefined && state === undefined) {
    return undefined;
  }
  return {
    hidden,
    label,
    role,
    state,
  };
}

type BaseProps = {
  readonly color?: TerminalColor | undefined;

  readonly backgroundColor?: TerminalColor | undefined;

  readonly italic?: boolean | undefined;

  readonly underline?: boolean | undefined;

  readonly strikethrough?: boolean | undefined;

  readonly inverse?: boolean | undefined;

  readonly wrap?: Styles["textWrap"];

  readonly "aria-hidden"?: boolean;

  readonly "aria-label"?: string;

  readonly "aria-role"?: string;

  readonly "aria-state"?: string;

  readonly children?: ReactNode;
};

type WeightProps =
  | { bold?: never; dim?: never }
  | { bold: boolean; dim?: never }
  | { dim: boolean; bold?: never };

export type Props = BaseProps & WeightProps;

const wrapStyleCache: Record<NonNullable<Styles["textWrap"]>, Styles> = {
  wrap: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: "row",
    textWrap: "wrap",
  },
  "wrap-trim": {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: "row",
    textWrap: "wrap-trim",
  },
  "wrap-stream": {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: "row",
    textWrap: "wrap-stream",
  },
  end: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: "row",
    textWrap: "end",
  },
  middle: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: "row",
    textWrap: "middle",
  },
  "truncate-end": {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: "row",
    textWrap: "truncate-end",
  },
  truncate: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: "row",
    textWrap: "truncate",
  },
  "truncate-middle": {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: "row",
    textWrap: "truncate-middle",
  },
  "truncate-start": {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: "row",
    textWrap: "truncate-start",
  },
} as const;

export default function StyledText({
  color,
  backgroundColor,
  bold,
  dim,
  italic = false,
  underline = false,
  strikethrough = false,
  inverse = false,
  wrap = "wrap",
  children,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
  "aria-role": ariaRole,
  "aria-state": ariaState,
}: Props): React.ReactNode {
  if (children === undefined || children === null) {
    return null;
  }

  const textStyles: TerminalTextStyle = {
    ...(color && { color }),
    ...(backgroundColor && { backgroundColor }),
    ...(dim && { dim }),
    ...(bold && { bold }),
    ...(italic && { italic }),
    ...(underline && { underline }),
    ...(strikethrough && { strikethrough }),
    ...(inverse && { inverse }),
  };

  const accessibility = createAccessibility(ariaHidden, ariaLabel, ariaRole, ariaState);

  return (
    <ink-text style={wrapStyleCache[wrap]} textStyles={textStyles} accessibility={accessibility}>
      {children}
    </ink-text>
  );
}
