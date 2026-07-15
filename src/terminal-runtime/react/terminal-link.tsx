import type { ReactNode } from "react";
import React from "react";
import StyledText from "@/terminal-runtime/react/styled-text.js";
import { detectHyperlinkCapability } from "@/terminal-runtime/terminal/link-capability.js";

export type Props = {
  readonly children?: ReactNode;
  readonly url: string;
  readonly fallback?: ReactNode;
};

export default function TerminalLink({ children, url, fallback }: Props): React.ReactNode {
  const content = children ?? url;

  if (detectHyperlinkCapability()) {
    return (
      <StyledText>
        <ink-link href={url}>{content}</ink-link>
      </StyledText>
    );
  }

  return <StyledText>{fallback ?? content}</StyledText>;
}
