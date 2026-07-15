import React from "react";
import type { Styles, TerminalColor } from "@/terminal-runtime/paint/style-model.js";
import StyledText from "@/terminal-runtime/react/styled-text.js";
import TerminalLink from "@/terminal-runtime/react/terminal-link.js";
import {
  type NamedColor,
  Parser,
  type Color as TermioColor,
  type TextStyle,
} from "@/terminal-runtime/terminal/control-index.js";

type Props = {
  children: string;

  dimColor?: boolean;
  wrap?: Styles["textWrap"];
};

type SpanProps = {
  color?: TerminalColor;
  backgroundColor?: TerminalColor;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  hyperlink?: string;
};

export const AnsiText = React.memo(function AnsiText({
  children,
  dimColor,
  wrap,
}: Props): React.ReactNode {
  if (typeof children !== "string") {
    return dimColor ? (
      <StyledText dim wrap={wrap}>
        {String(children)}
      </StyledText>
    ) : (
      <StyledText wrap={wrap}>{String(children)}</StyledText>
    );
  }

  if (children === "") {
    return null;
  }

  const spans = parseToSpans(children);

  if (spans.length === 0) {
    return null;
  }

  if (spans.length === 1 && !hasAnyProps(spans[0]!.props)) {
    return dimColor ? (
      <StyledText dim wrap={wrap}>
        {spans[0]!.text}
      </StyledText>
    ) : (
      <StyledText wrap={wrap}>{spans[0]!.text}</StyledText>
    );
  }

  const content = spans.map((span, i) => {
    const hyperlink = span.props.hyperlink;

    if (dimColor) {
      span.props.dim = true;
    }
    const hasTextProps = hasAnyTextProps(span.props);

    if (hyperlink) {
      return hasTextProps ? (
        <TerminalLink key={i} url={hyperlink}>
          <StyleSpan
            color={span.props.color}
            backgroundColor={span.props.backgroundColor}
            dim={span.props.dim}
            bold={span.props.bold}
            italic={span.props.italic}
            underline={span.props.underline}
            strikethrough={span.props.strikethrough}
            inverse={span.props.inverse}
          >
            {span.text}
          </StyleSpan>
        </TerminalLink>
      ) : (
        <TerminalLink key={i} url={hyperlink}>
          {span.text}
        </TerminalLink>
      );
    }

    return hasTextProps ? (
      <StyleSpan
        key={i}
        color={span.props.color}
        backgroundColor={span.props.backgroundColor}
        dim={span.props.dim}
        bold={span.props.bold}
        italic={span.props.italic}
        underline={span.props.underline}
        strikethrough={span.props.strikethrough}
        inverse={span.props.inverse}
      >
        {span.text}
      </StyleSpan>
    ) : (
      span.text
    );
  });

  return dimColor ? (
    <StyledText dim wrap={wrap}>
      {content}
    </StyledText>
  ) : (
    <StyledText wrap={wrap}>{content}</StyledText>
  );
});

type Span = {
  text: string;
  props: SpanProps;
};

function parseToSpans(input: string): Span[] {
  const parser = new Parser();
  const actions = parser.feed(input);
  const spans: Span[] = [];

  let currentHyperlink: string | undefined;

  for (const action of actions) {
    if (action.type === "link") {
      if (action.action.type === "start") {
        currentHyperlink = action.action.url;
      } else {
        currentHyperlink = undefined;
      }
      continue;
    }

    if (action.type === "text") {
      const text = action.graphemes.map((g) => g.value).join("");
      if (!text) continue;

      const props = textStyleToSpanProps(action.style);
      if (currentHyperlink) {
        props.hyperlink = currentHyperlink;
      }

      const lastSpan = spans[spans.length - 1];
      if (lastSpan && propsEqual(lastSpan.props, props)) {
        lastSpan.text += text;
      } else {
        spans.push({ text, props });
      }
    }
  }

  return spans;
}

function textStyleToSpanProps(style: TextStyle): SpanProps {
  const props: SpanProps = {};

  if (style.bold) props.bold = true;
  if (style.dim) props.dim = true;
  if (style.italic) props.italic = true;
  if (style.underline !== "none") props.underline = true;
  if (style.strikethrough) props.strikethrough = true;
  if (style.inverse) props.inverse = true;

  const fgColor = colorToString(style.fg);
  if (fgColor) props.color = fgColor;

  const bgColor = colorToString(style.bg);
  if (bgColor) props.backgroundColor = bgColor;

  return props;
}

const NAMED_COLOR_MAP: Record<NamedColor, string> = {
  black: "ansi:black",
  red: "ansi:red",
  green: "ansi:green",
  yellow: "ansi:yellow",
  blue: "ansi:blue",
  magenta: "ansi:magenta",
  cyan: "ansi:cyan",
  white: "ansi:white",
  brightBlack: "ansi:blackBright",
  brightRed: "ansi:redBright",
  brightGreen: "ansi:greenBright",
  brightYellow: "ansi:yellowBright",
  brightBlue: "ansi:blueBright",
  brightMagenta: "ansi:magentaBright",
  brightCyan: "ansi:cyanBright",
  brightWhite: "ansi:whiteBright",
};

function colorToString(color: TermioColor): TerminalColor | undefined {
  switch (color.type) {
    case "named":
      return NAMED_COLOR_MAP[color.name] as TerminalColor;
    case "indexed":
      return `ansi256(${color.index})` as TerminalColor;
    case "rgb":
      return `rgb(${color.r},${color.g},${color.b})` as TerminalColor;
    case "default":
      return undefined;
  }
}

function propsEqual(a: SpanProps, b: SpanProps): boolean {
  return (
    a.color === b.color &&
    a.backgroundColor === b.backgroundColor &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.inverse === b.inverse &&
    a.hyperlink === b.hyperlink
  );
}

function hasAnyProps(props: SpanProps): boolean {
  return (
    props.color !== undefined ||
    props.backgroundColor !== undefined ||
    props.dim === true ||
    props.bold === true ||
    props.italic === true ||
    props.underline === true ||
    props.strikethrough === true ||
    props.inverse === true ||
    props.hyperlink !== undefined
  );
}

function hasAnyTextProps(props: SpanProps): boolean {
  return (
    props.color !== undefined ||
    props.backgroundColor !== undefined ||
    props.dim === true ||
    props.bold === true ||
    props.italic === true ||
    props.underline === true ||
    props.strikethrough === true ||
    props.inverse === true
  );
}

type BaseTextStyleProps = {
  color?: TerminalColor | undefined;
  backgroundColor?: TerminalColor | undefined;
  italic?: boolean | undefined;
  underline?: boolean | undefined;
  strikethrough?: boolean | undefined;
  inverse?: boolean | undefined;
};

function StyleSpan({
  bold,
  dim,
  children,
  ...rest
}: BaseTextStyleProps & {
  bold?: boolean | undefined;
  dim?: boolean | undefined;
  children: string;
}): React.ReactNode {
  if (dim) {
    return (
      <StyledText {...rest} dim>
        {children}
      </StyledText>
    );
  }
  if (bold) {
    return (
      <StyledText {...rest} bold>
        {children}
      </StyledText>
    );
  }
  return <StyledText {...rest}>{children}</StyledText>;
}
